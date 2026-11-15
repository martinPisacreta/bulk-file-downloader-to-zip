import { Actor } from 'apify';
import { main } from './actor.mjs';

await Actor.init();
await main(Actor);
await Actor.exit();
