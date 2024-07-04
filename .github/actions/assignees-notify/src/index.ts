import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import * as core from '@actions/core';
import { DISCORD_BOT_TOKEN, DISCORD_READY_ISSUE_CHANNEL } from './credentials/credentials';

// Create a new client instance

const main = async () => {
    try {
        const client = new Client({ intents: [GatewayIntentBits.Guilds] });

        // When the client is ready, run this code (only once)
        client.once('ready', async () => {
            const channel = client.channels.cache.get(DISCORD_READY_ISSUE_CHANNEL) as TextChannel; // Ready-Issue
            const githubRef = core.getInput('ref');
            const messages = await channel.messages.fetch();
            const target = messages.find(msg => msg.content.endsWith(githubRef));
            if (target){
                target.react('✅').then(
                    () => {process.exit(0);}
                );
            } else {
                console.log('There are no target.')
                process.exit(0);
            }
        });

        // Login to Discord with your client's token
        void client.login(DISCORD_BOT_TOKEN);
    }
    catch (e) {
        console.error(e);
    }
}
main()
