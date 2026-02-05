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

async function connectWithRetry(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔌 Connecting to Bright Data (attempt ${attempt}/${maxRetries})...`);
            const browser = await chromium.connectOverCDP(SBR_WS_ENDPOINT);
            return browser;
        } catch (e) {
            console.log(`⚠️ Connection attempt ${attempt} failed:`, e.message);
            if (attempt === maxRetries) throw e;
            await new Promise(r => setTimeout(r, 5000 * attempt));
        }
    }
}

async function scrapeLinkedIn() {
    console.log('🔌 Connecting to Bright Data Scraping Browser...');
    
    const browser = await connectWithRetry(3);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    try {
        console.log('🔐 Checking LinkedIn session...');
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle' });
        
        // Check if already logged in (redirected to feed)
        const url = page.url();
        if (url.includes('/feed') || !url.includes('/login')) {
            console.log('✅ Already logged in!');
        } else {
            // Perform login
            await page.fill('input[name="session_key"]', LINKEDIN_EMAIL);
            await page.fill('input[name="session_password"]', LINKEDIN_PASSWORD);
            await page.click('button[type="submit"]');
            
            // Wait for login with multiple fallback strategies
            console.log('⏳ Waiting for login to complete...');
            
            // Strategy 1: Wait for feed URL
            try {
                await page.waitForURL('**/feed/**', { timeout: 30000 });
                console.log('✅ Logged in (feed detected)!');
            } catch (e) {
                console.log('⚠️ Feed navigation timeout, checking for alternatives...');
                
                // Strategy 2: Check if we're on a security/challenge page
                const currentUrl = page.url();
                console.log('🔍 Current URL:', currentUrl);
                
                if (currentUrl.includes('checkpoint') || currentUrl.includes('challenge')) {
                    console.log('🔒 Security checkpoint detected - manual intervention may be needed');
                    await page.waitForTimeout(60000);
                }
                
                // Strategy 3: Check if we're already on a logged-in page
                const isLoggedIn = await page.evaluate(() => {
                    return !!document.querySelector('.global-nav__me') || 
                           !!document.querySelector('.feed-identity-module') ||
                           !!document.querySelector('a[href="/messaging/"]');
                });
                
                if (isLoggedIn) {
                    console.log('✅ Logged in (detected via page elements)!');
                } else {
                    throw new Error('Login failed - unable to detect logged-in state. URL: ' + currentUrl);
                }
            }
        }

        // Go to messages with retry
        console.log('📬 Navigating to messages...');
        await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);

        // Handle Cookie Banner - LinkedIn's new consent screen
        try {
            console.log('🍪 Checking for cookie/consent banner...');
            await page.waitForTimeout(2000);
            
            // Multiple strategies for cookie acceptance
            const cookieSelectors = [
                'button[action-type="ACCEPT"]',
                'button[data-control-name="ga-cookie.accept"]', 
                '.artdeco-global-alert-action__button',
                'button:has-text("Accept")',
                'button:has-text("Accepter")',
                '[data-testid="accept-cookie-banner-button"]',
                '.truste-button',
                'button[id*="accept"]',
                'button[class*="accept"]',
                'button:has-text("Agree")',
                'button:has-text("Continue")'
            ];
            
            for (const selector of cookieSelectors) {
                const btn = await page.$(selector);
                if (btn) {
                    console.log(`🍪 Clicking cookie button: ${selector}`);
                    await btn.click();
                    await page.waitForTimeout(1500);
                    break;
                }
            }
            
            // Alternative: Click by text content evaluation
            const clicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const acceptBtn = buttons.find(b => 
                    b.textContent?.toLowerCase().includes('accept') ||
                    b.textContent?.toLowerCase().includes('accepter') ||
                    b.textContent?.toLowerCase().includes('agree') ||
                    b.textContent?.toLowerCase().includes('continue') ||
                    b.textContent?.toLowerCase().includes('consent')
                );
                if (acceptBtn) {
                    acceptBtn.click();
                    return true;
                }
                return false;
            });
            
            if (clicked) {
                console.log('🍪 Cookie banner handled via text matching');
                await page.waitForTimeout(1500);
            } else {
                console.log('🍪 No cookie banner found or already accepted');
            }
            
        } catch (e) { 
            console.log('🍪 Cookie handling error:', e.message); 
        }

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
