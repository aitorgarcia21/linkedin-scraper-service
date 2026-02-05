const { chromium } = require('playwright-core');
const { createClient } = require('@supabase/supabase-js');

// Config
const AUTH = process.env.BRIGHT_DATA_AUTH || '11360349-4ffd-4184-bf91-eec8386a00b9';
const SBR_WS_ENDPOINT = `wss://${AUTH}@brd.superproxy.io:9222`;

const LINKEDIN_EMAIL = process.env.LINKEDIN_EMAIL || 'aitorgarcia2112@gmail.com';
const LINKEDIN_PASSWORD = process.env.LINKEDIN_PASSWORD || '21AiPa01....';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://igyxcobujacampiqndpf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlneXhjb2J1amFjYW1waXFuZHBmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5NDYxMTUsImV4cCI6MjA4NTUyMjExNX0.8jgz6G0Irj6sRclcBKzYE5VzzXNrxzHgrAz45tHfHpc';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function scrapeLinkedIn() {
    console.log('🔌 Connecting to Bright Data Scraping Browser...');

    const browser = await chromium.connectOverCDP(SBR_WS_ENDPOINT);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    try {
        console.log('🔐 Logging into LinkedIn...');
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle' });

        await page.fill('input[name="session_key"]', LINKEDIN_EMAIL);
        await page.fill('input[name="session_password"]', LINKEDIN_PASSWORD);
        await page.click('button[type="submit"]');

        // Wait for login
        await page.waitForURL('**/feed/**', { timeout: 60000 });
        console.log('✅ Logged in!');

        // Go to messages
        console.log('📬 Navigating to messages...');
        await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);

        // Get conversation list
        const conversationElements = await page.$$('.msg-conversation-listitem');
        console.log(`📨 Found ${conversationElements.length} conversations`);

        const allData = [];

        for (let i = 0; i < Math.min(conversationElements.length, 30); i++) {
            try {
                // Click conversation
                const convItems = await page.$$('.msg-conversation-listitem');
                await convItems[i].click();
                await page.waitForTimeout(2000);

                // Get prospect name
                const nameEl = await page.$('.msg-entity-lockup__entity-title');
                const prospectName = nameEl ? await nameEl.innerText() : 'Unknown';

                // Get profile URL
                const linkEl = await page.$('.msg-entity-lockup__entity-title a');
                const prospectUrl = linkEl ? await linkEl.getAttribute('href') : '';

                // Get messages
                const messageEls = await page.$$('.msg-s-event-listitem');
                const messages = [];

                for (const msgEl of messageEls) {
                    const isSelf = await msgEl.$('.msg-s-message-list__event--from-self');
                    const sender = isSelf ? 'me' : 'them';

                    const contentEl = await msgEl.$('.msg-s-event-listitem__body');
                    const content = contentEl ? await contentEl.innerText() : '';

                    const timeEl = await msgEl.$('time');
                    const timestamp = timeEl ? await timeEl.getAttribute('datetime') : new Date().toISOString();

                    if (content.trim()) {
                        messages.push({ sender, content: content.trim(), timestamp });
                    }
                }

                allData.push({
                    prospect_name: prospectName.trim(),
                    prospect_url: prospectUrl,
                    messages
                });

                console.log(`✅ Scraped ${i + 1}/${Math.min(conversationElements.length, 30)}: ${prospectName}`);

            } catch (e) {
                console.log(`⚠️ Error on conversation ${i + 1}:`, e.message);
            }
        }

        // Save to Supabase
        console.log('💾 Saving to Supabase...');
        let saved = 0;

        for (const conv of allData) {
            try {
                // Upsert prospect
                const { data: prospect } = await supabase
                    .from('prospects')
                    .upsert({
                        linkedin_url: conv.prospect_url,
                        name: conv.prospect_name
                    }, { onConflict: 'linkedin_url' })
                    .select()
                    .single();

                // Upsert conversation
                const { data: conversation } = await supabase
                    .from('conversations')
                    .upsert({
                        prospect_id: prospect.id,
                        linkedin_conversation_id: conv.prospect_url,
                        last_message_by: conv.messages.length ? conv.messages[conv.messages.length - 1].sender : 'unknown',
                        last_message_at: conv.messages.length ? conv.messages[conv.messages.length - 1].timestamp : new Date().toISOString()
                    }, { onConflict: 'linkedin_conversation_id' })
                    .select()
                    .single();

                // Insert messages
                for (const msg of conv.messages) {
                    await supabase
                        .from('messages')
                        .upsert({
                            conversation_id: conversation.id,
                            sender: msg.sender,
                            content: msg.content,
                            timestamp: msg.timestamp
                        }, { onConflict: 'conversation_id,content,timestamp' });
                }

                saved++;
            } catch (e) {
                console.log(`⚠️ Error saving ${conv.prospect_name}:`, e.message);
            }
        }

        console.log(`🎉 Done! Saved ${saved}/${allData.length} conversations`);

        return { scraped: allData.length, saved };

    } finally {
        await browser.close();
    }
}

module.exports = { scrapeLinkedIn };

// Run directly if called as script
if (require.main === module) {
    scrapeLinkedIn()
        .then(console.log)
        .catch(console.error);
}
