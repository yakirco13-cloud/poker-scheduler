import cron from 'node-cron';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_API_KEY = process.env.BASE44_API_KEY;
const BASE_URL = `https://app.base44.com/api/apps/${BASE44_APP_ID}`;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

const TEMPLATE_REGISTRATION_OPEN = process.env.TEMPLATE_REGISTRATION_OPEN;
const TEMPLATE_GAME_REMINDER = process.env.TEMPLATE_GAME_REMINDER;

const dayNameToIndex = {
  'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
  'thursday': 4, 'friday': 5, 'saturday': 6
};

async function base44Fetch(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${BASE_URL}${endpoint}`, options);
  if (!response.ok) throw new Error(`Base44 API error: ${response.status}`);
  return response.json();
}

async function listEntities(entityName) {
  return base44Fetch(`/entities/${entityName}`);
}

async function filterEntities(entityName, filters) {
  const params = new URLSearchParams(filters).toString();
  return base44Fetch(`/entities/${entityName}?${params}`);
}

async function getEntity(entityName, id) {
  return base44Fetch(`/entities/${entityName}/${id}`);
}

async function updateEntity(entityName, id, data) {
  return base44Fetch(`/entities/${entityName}/${id}`, 'PUT', data);
}

function formatPhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '972' + cleaned.slice(1);
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
  return cleaned;
}

async function sendWhatsAppTemplate(to, contentSid, variables) {
  try {
    const phone = formatPhone(to);
    await twilioClient.messages.create({
      from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${phone}`,
      contentSid: contentSid,
      contentVariables: JSON.stringify(variables)
    });
    console.log(`WhatsApp sent to ${phone}`);
    return true;
  } catch (error) {
    console.error(`Failed to send WhatsApp to ${to}:`, error.message);
    return false;
  }
}

async function getGroupMembersWithPhones(groupId) {
  try {
    const members = await filterEntities('GroupMember', { groupId, isActive: true });
    const users = await listEntities('User');
    return members
      .map(member => {
        const user = users.find(u => u.id === member.userId);
        return { ...member, phone: user?.phone || member.phone, displayName: user?.displayName || member.displayName || 'שחקן' };
      })
      .filter(m => m.phone);
  } catch (error) {
    console.error('Error getting members:', error);
    return [];
  }
}

async function checkAutoOpenRegistration() {
  console.log(`[${new Date().toISOString()}] Checking auto-open registration...`);
  try {
    const allSettings = await listEntities('GroupSettings');
    const now = new Date();
    const currentDay = now.getDay();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    for (const settings of allSettings) {
      if (!settings.autoOpenRegistrationEnabled) continue;
      const targetDayIndex = dayNameToIndex[settings.autoOpenRegistrationDay];
      if (targetDayIndex === undefined || currentDay !== targetDayIndex) continue;
      const [targetHour, targetMinute] = (settings.autoOpenRegistrationTime || '12:00').split(':').map(Number);
      const targetMinutes = targetHour * 60 + targetMinute;
      if (Math.abs(currentMinutes - targetMinutes) > 2) continue;

      const games = await filterEntities('Game', { groupId: settings.groupId });
      const scheduledGames = games.filter(g => g.status === 'scheduled' && !g.registrationOpen && new Date(g.startAt) > now);

      for (const game of scheduledGames) {
        console.log(`Opening registration for game ${game.id}`);
        await updateEntity('Game', game.id, { registrationOpen: true });

        if (settings.sendReminderOnRegistrationOpen) {
          const members = await getGroupMembersWithPhones(settings.groupId);
          const group = await getEntity('Group', settings.groupId);
          const link = `https://techholdem.me/NextGame?groupId=${settings.groupId}`;
          for (const member of members) {
            await sendWhatsAppTemplate(member.phone, TEMPLATE_REGISTRATION_OPEN, {
              "1": member.displayName, "2": group?.name || 'פוקר', "3": link
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in auto-open registration:', error);
  }
}

async function checkGameDayReminders() {
  console.log(`[${new Date().toISOString()}] Checking game day reminders...`);
  try {
    const allSettings = await listEntities('GroupSettings');
    const now = new Date();

    for (const settings of allSettings) {
      if (!settings.dayOfGamePushEnabled) continue;
      const offsetMinutes = settings.dayOfGamePushOffsetMinutes || 60;
      const games = await filterEntities('Game', { groupId: settings.groupId });

      for (const game of games) {
        if (game.status !== 'scheduled' && game.status !== 'active') continue;
        if (game.reminderSent) continue;
        const gameTime = new Date(game.startAt);
        const reminderTime = new Date(gameTime.getTime() - offsetMinutes * 60 * 1000);
        const diffMs = now.getTime() - reminderTime.getTime();
        if (diffMs < 0 || diffMs > 2 * 60 * 1000) continue;

        console.log(`Sending reminder for game ${game.id}`);
        await updateEntity('Game', game.id, { reminderSent: true });
        const seatedUserIds = (game.seats || []).map(s => s.userId);
        const members = await getGroupMembersWithPhones(settings.groupId);
        const seatedMembers = members.filter(m => seatedUserIds.includes(m.userId));
        const group = await getEntity('Group', settings.groupId);

        for (const member of seatedMembers) {
          await sendWhatsAppTemplate(member.phone, TEMPLATE_GAME_REMINDER, { "1": group?.name || 'פוקר' });
        }
      }
    }
  } catch (error) {
    console.error('Error in game day reminders:', error);
  }
}

cron.schedule('* * * * *', async () => {
  await checkAutoOpenRegistration();
  await checkGameDayReminders();
});

console.log('Poker Scheduler started!');
checkAutoOpenRegistration();
checkGameDayReminders();