"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const core = require("@actions/core");
const credentials_1 = require("./credentials/credentials");
// Create a new client instance
const main = () => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const client = new discord_js_1.Client({ intents: [discord_js_1.GatewayIntentBits.Guilds] });
        // When the client is ready, run this code (only once)
        client.once('ready', () => __awaiter(void 0, void 0, void 0, function* () {
            const channel = client.channels.cache.get(credentials_1.DISCORD_READY_ISSUE_CHANNEL); // Ready-Issue
            const githubRef = core.getInput('ref');
            const messages = yield channel.messages.fetch();
            const target = messages.find(msg => msg.content.endsWith(githubRef));
            if (target) {
                target.react('✅').then(() => { process.exit(0); });
            }
            else {
                console.log('There are no target.');
                process.exit(0);
            }
        }));
        // Login to Discord with your client's token
        void client.login(credentials_1.DISCORD_BOT_TOKEN);
    }
    catch (e) {
        console.error(e);
    }
});
main();
