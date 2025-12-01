import { createClient } from '@base44/sdk';
import cron from 'node-cron';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

// Base44 client
const base44 = createClient({
  appId: process.env.BASE44_APP_ID,
  apiKey: process.env.BASE44_API_KEY,
});

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// Template SIDs
const TEMPLATE_REGISTRATION_OPEN = process.env.TEMPLATE_REGISTRATION_OPEN;
const TEMPLATE_GAME_REMINDER = process.env.TEMPLATE_GAME_REMINDER;

// Day name to index mapping
const dayNameToIndex = {
  'sunday': 0,
  'monday': 1,
  'tuesday': 2,
  'wednesday': 3,
  'thursday': 4,
  'friday': 5,
  'saturday': 6
};

// Format phone number for WhatsApp
function formatPhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '972' + cleaned.slice(1);
  }
  if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }
  return cleaned;
}

// Send WhatsApp template message
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

// Get group members with phone numbers and names
async function getGroupMembersWithPhones(groupId) {
  try {
    const members = await base44.entities.GroupMember.filter({ groupId, isActive: true });
    const users = await base44.entities.User.list();
    
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

// Check and auto-open registration
async function checkAutoOpenRegistration() {
  console.log(`[${new Date().toISOString()}] Checking auto-open registration...`);
  
  try {
    const allSettings = await base44.entities.GroupSettings.list();
    const now = new Date();
    const currentDay = now.getDay();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    
    for (const settings of allSettings) {
      if (!settings.autoOpenRegistrationEnabled) continue;
      
      const targetDayIndex = dayNameToIndex[settings.autoOpenRegistrationDay];
      if (targetDayIndex === undefined || currentDay !== targetDayIndex) continue;
      
      const [targetHour, targetMinute] = (settings.autoOpenRegistrationTime || '12:00').split(':').map(Number);
      const targetMinutes = targetHour * 60 + targetMinute;
      
      // Check if we're within the target window (within 2 minutes)
      if (Math.abs(currentMinutes - targetMinutes) > 2) continue;
      
      // Find scheduled games for this group
      const games = await base44.entities.Game.filter({ groupId: settings.groupId });
      const scheduledGames = games.filter(g => 
        g.status === 'scheduled' && 
        !g.registrationOpen &&
        new Date(g.startAt) > now
      );
      
      for (const game of scheduledGames) {
        console.log(`Opening registration for game ${game.id} in group ${settings.groupId}`);
        
        await base44.entities.Game.update(game.id, { registrationOpen: true });
        
        // Send WhatsApp notifications if enabled
        if (settings.sendReminderOnRegistrationOpen) {
          const members = await getGroupMembersWithPhones(settings.groupId);
          const group = await base44.entities.Group.get(settings.groupId);
          const link = `https://techholdem.me/NextGame?groupId=${settings.groupId}`;
          
          for (const member of members) {
            // Template: poker_reminder
            // {{1}} = User name, {{2}} = Group name, {{3}} = Link
            await sendWhatsAppTemplate(member.phone, TEMPLATE_REGISTRATION_OPEN, {
              "1": member.displayName,
              "2": group?.name || 'פוקר',
              "3": link
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in auto-open registration:', error);
  }
}

// Check and send game day reminders
async function checkGameDayReminders() {
  console.log(`[${new Date().toISOString()}] Checking game day reminders...`);
  
  try {
    const allSettings = await base44.entities.GroupSettings.list();
    const now = new Date();
    
    for (const settings of allSettings) {
      if (!settings.dayOfGamePushEnabled) continue;
      
      const offsetMinutes = settings.dayOfGamePushOffsetMinutes || 60;
      
      // Find active/scheduled games for this group
      const games = await base44.entities.Game.filter({ groupId: settings.groupId });
      
      for (const game of games) {
        if (game.status !== 'scheduled' && game.status !== 'active') continue;
        if (game.reminderSent) continue;
        
        const gameTime = new Date(game.startAt);
        const reminderTime = new Date(gameTime.getTime() - offsetMinutes * 60 * 1000);
        
        // Check if we're within 2 minutes of reminder time
        const diffMs = now.getTime() - reminderTime.getTime();
        if (diffMs < 0 || diffMs > 2 * 60 * 1000) continue;
        
        console.log(`Sending reminder for game ${game.id}`);
        
        // Mark reminder as sent
        await base44.entities.Game.update(game.id, { reminderSent: true });
        
        // Get members who are seated
        const seatedUserIds = (game.seats || []).map(s => s.userId);
        const members = await getGroupMembersWithPhones(settings.groupId);
        const seatedMembers = members.filter(m => seatedUserIds.includes(m.userId));
        
        const group = await base44.entities.Group.get(settings.groupId);
        
        for (const member of seatedMembers) {
          // Template: game_reminder
          // {{1}} = Group name
          await sendWhatsAppTemplate(member.phone, TEMPLATE_GAME_REMINDER, {
            "1": group?.name || 'פוקר'
          });
        }
      }
    }
  } catch (error) {
    console.error('Error in game day reminders:', error);
  }
}

// Run checks every minute
cron.schedule('* * * * *', async () => {
  await checkAutoOpenRegistration();
  await checkGameDayReminders();
});

console.log('Poker Scheduler started!');
console.log('Running checks every minute...');

// Initial check on startup
checkAutoOpenRegistration();
checkGameDayReminders();
