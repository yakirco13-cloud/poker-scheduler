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

// Sanitize variables for Twilio - remove special chars that cause error 21656
function sanitizeVariable(value) {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }
  return String(value)
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/\s{4,}/g, '   ')
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/"/g, '"')
    .replace(/"/g, '"')
    .trim() || 'N/A';
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
    
    const sanitizedVars = {};
    for (const [key, value] of Object.entries(variables)) {
      sanitizedVars[key] = sanitizeVariable(value);
    }
    
    console.log(`Sending WhatsApp to ${phone} with template ${contentSid}`);
    console.log(`Variables:`, JSON.stringify(sanitizedVars));
    
    const message = await twilioClient.messages.create({
      from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${phone}`,
      contentSid: contentSid,
      contentVariables: JSON.stringify(sanitizedVars)
    });
    
    console.log(`✅ WhatsApp sent to ${phone}, SID: ${message.sid}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send WhatsApp to ${to}:`, error.message);
    if (error.code) console.error(`Error code: ${error.code}`);
    if (error.moreInfo) console.error(`More info: ${error.moreInfo}`);
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
          displayName: user?.displayName || member.displayName || 'חבר' 
        };
      })
      .filter(m => m.phone);
  } catch (error) {
    console.error('Error getting members:', error);
    return [];
  }
}

async function checkRegistrationNotifications() {
  console.log(`\n[${new Date().toISOString()}] === CHECKING REGISTRATION NOTIFICATIONS ===`);
  
  try {
    const allSettings = await listEntities('GroupSettings');
    const allGames = await listEntities('Game');
    
    const gamesNeedingNotification = allGames.filter(g => 
      g.registrationOpen === true && 
      g.registrationNotificationSent !== true &&
      g.status === 'scheduled' &&
      new Date(g.startAt) > new Date()
    );
    
    console.log(`Found ${gamesNeedingNotification.length} games needing notification`);
    
    for (const game of gamesNeedingNotification) {
      const settings = allSettings.find(s => s.groupId === game.groupId);
      
      if (!settings?.sendReminderOnRegistrationOpen) {
        console.log(`⏭️ Skipping game ${game.id} - notifications disabled for group`);
        await updateEntity('Game', game.id, { registrationNotificationSent: true });
        continue;
      }
      
      console.log(`>>> 📨 Sending registration notification for game ${game.id}`);
      
      const members = await getGroupMembersWithPhones(game.groupId);
      console.log(`Found ${members.length} members with phones`);
      
      let group;
      try {
        group = await getEntity('Group', game.groupId);
      } catch (e) {
        console.error('Could not fetch group:', e.message);
        group = { name: 'פוקר' };
      }
      
      const link = `https://techholdem.me/NextGame?groupId=${game.groupId}`;
      
      let successCount = 0;
      let failCount = 0;
      
      for (const member of members) {
        const vars = {
          "1": member.displayName || 'חבר',
          "2": group?.name || 'פוקר',
          "3": link
        };
        
        const success = await sendWhatsAppTemplate(member.phone, TEMPLATE_REGISTRATION_OPEN, vars);
        if (success) {
          successCount++;
        } else {
          failCount++;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      console.log(`📊 Notification results: ${successCount} sent, ${failCount} failed`);
      
      await updateEntity('Game', game.id, { registrationNotificationSent: true });
    }
  } catch (error) {
    console.error('Error checking registration notifications:', error);
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
      
      if (Math.abs(currentMinutes - targetMinutes) > 5) continue;

      console.log('⏰ TIME MATCH! Looking for games...');
      const games = await filterEntities('Game', { groupId: settings.groupId });
      const scheduledGames = games.filter(g => 
        g.status === 'scheduled' && 
        !g.registrationOpen && 
        new Date(g.startAt) > new Date()
      );

      for (const game of scheduledGames) {
        console.log(`>>> 🔓 OPENING registration for game ${game.id}`);
        await updateEntity('Game', game.id, { registrationOpen: true });
      }
    }
  } catch (error) {
    console.error('Error in auto-open registration:', error);
  }
}

async function checkGameDayReminders() {
  console.log(`\n[${new Date().toISOString()}] === CHECKING GAME DAY REMINDERS ===`);
  
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
        if (diffMs < 0 || diffMs > 5 * 60 * 1000) continue;

        console.log(`>>> 🔔 Sending reminder for game ${game.id}`);
        await updateEntity('Game', game.id, { reminderSent: true });
        const seatedUserIds = (game.seats || []).map(s => s.userId);
        const members = await getGroupMembersWithPhones(settings.groupId);
        const seatedMembers = members.filter(m => seatedUserIds.includes(m.userId));
        
        let group;
        try {
          group = await getEntity('Group', settings.groupId);
        } catch (e) {
          console.error('Could not fetch group:', e.message);
          group = { name: 'פוקר' };
        }

        let successCount = 0;
        let failCount = 0;

        for (const member of seatedMembers) {
          const vars = {
            "1": group?.name || 'פוקר'
          };
          const success = await sendWhatsAppTemplate(member.phone, TEMPLATE_GAME_REMINDER, vars);
          if (success) {
            successCount++;
          } else {
            failCount++;
          }
          
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log(`📊 Reminder results: ${successCount} sent, ${failCount} failed`);
      }
    }
  } catch (error) {
    console.error('Error in game day reminders:', error);
  }
}

async function runAllChecks() {
  console.log('\n' + '='.repeat(60));
  console.log(`🎰 Poker Scheduler Check - ${new Date().toISOString()}`);
  console.log('='.repeat(60));
  
  await checkAutoOpenRegistration();
  await checkRegistrationNotifications();
  await checkGameDayReminders();
  
  console.log('\n✅ All checks completed\n');
}

cron.schedule('*/5 * * * *', runAllChecks);

console.log('🎰 Poker Scheduler started! Running every 5 minutes.');
console.log('Running initial check...');
runAllChecks();