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

function getIsraelTime() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
}

async function base44Fetch(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${BASE_URL}${endpoint}`, options);
  if (!response.ok) {
    const text = await response.text();
    console.error(`API Error: ${response.status} - ${text}`);
    throw new Error(`Base44 API error: ${response.status}`);
  }
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
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '972' + cleaned.slice(1);
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
  return cleaned;
}

async function sendWhatsAppTemplate(to, contentSid, variables) {
  try {
    const phone = formatPhone(to);
    
    console.log(`Sending WhatsApp to ${phone} with template ${contentSid}`);
    console.log(`Variables:`, variables);
    
    const message = await twilioClient.messages.create({
      from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${phone}`,
      contentSid: contentSid,
      contentVariables: JSON.stringify(variables)
    });
    
    console.log(`WhatsApp sent to ${phone}, SID: ${message.sid}`);
    return true;
  } catch (error) {
    console.error(`Failed to send WhatsApp to ${to}:`, error.message);
    console.error(`Full error:`, JSON.stringify(error, null, 2));
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
        return { 
          ...member, 
          phone: user?.phone || member.phone, 
          displayName: user?.displayName || member.displayName || 'שחקן' 
        };
      })
      .filter(m => m.phone);
  } catch (error) {
    console.error('Error getting members:', error);
    return [];
  }
}

async function checkAutoOpenRegistration() {
  const now = getIsraelTime();
  const currentDay = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  console.log(`\n[${new Date().toISOString()}] === AUTO-OPEN CHECK ===`);
  console.log(`Israel Time: Day=${currentDay}, Time=${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`);
  
  try {
    const allSettings = await listEntities('GroupSettings');

    for (const settings of allSettings) {
      if (!settings.autoOpenRegistrationEnabled) continue;
      
      const targetDayIndex = dayNameToIndex[settings.autoOpenRegistrationDay];
      if (targetDayIndex === undefined || currentDay !== targetDayIndex) continue;
      
      const [targetHour, targetMinute] = (settings.autoOpenRegistrationTime || '12:00').split(':').map(Number);
      const targetMinutes = targetHour * 60 + targetMinute;
      
      if (Math.abs(currentMinutes - targetMinutes) > 2) continue;

      console.log('TIME MATCH! Looking for games...');
      const games = await filterEntities('Game', { groupId: settings.groupId });
      const scheduledGames = games.filter(g => g.status === 'scheduled' && !g.registrationOpen && new Date(g.startAt) > new Date());

      for (const game of scheduledGames) {
        console.log(`>>> OPENING registration for game ${game.id}`);
        await updateEntity('Game', game.id, { registrationOpen: true });

        if (settings.sendReminderOnRegistrationOpen) {
          const members = await getGroupMembersWithPhones(settings.groupId);
          console.log(`Found ${members.length} members with phones`);
          
          const group = await getEntity('Group', settings.groupId);
          const link = `https://techholdem.me/NextGame?groupId=${settings.groupId}`;
          
          for (const member of members) {
            const vars = {
              "1": String(member.displayName || 'שחקן'),
              "2": String(group?.name || 'פוקר'),
              "3": String(link)
            };
            await sendWhatsAppTemplate(member.phone, TEMPLATE_REGISTRATION_OPEN, vars);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in auto-open registration:', error);
  }
}

async function checkGameDayReminders() {
  const now = getIsraelTime();
  console.log(`[${new Date().toISOString()}] Checking game day reminders...`);
  
  try {
    const allSettings = await listEntities('GroupSettings');

    for (const settings of allSettings) {
      if (!settings.dayOfGamePushEnabled) continue;
      const offsetMinutes = settings.dayOfGamePushOffsetMinutes || 60;
      const games = await filterEntities('Game', { groupId: settings.groupId });

      for (const game of games) {
        if (game.status !== 'scheduled' && game.status !== 'active') continue;
        if (game.reminderSent) continue;
        const gameTime = new Date(game.startAt);
        const reminderTime = new Date(gameTime.getTime() - offsetMinutes * 60 * 1000);
        const diffMs = new Date().getTime() - reminderTime.getTime();
        if (diffMs < 0 || diffMs > 2 * 60 * 1000) continue;

        console.log(`Sending reminder for game ${game.id}`);
        await updateEntity('Game', game.id, { reminderSent: true });
        const seatedUserIds = (game.seats || []).map(s => s.userId);
        const members = await getGroupMembersWithPhones(settings.groupId);
        const seatedMembers = members.filter(m => seatedUserIds.includes(m.userId));
        const group = await getEntity('Group', settings.groupId);

        for (const member of seatedMembers) {
          const vars = {
            "1": String(group?.name || 'פוקר')
          };
          await sendWhatsAppTemplate(member.phone, TEMPLATE_GAME_REMINDER, vars);
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