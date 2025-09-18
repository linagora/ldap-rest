#!/usr/bin/env node

import { DM } from '../dist/bin/index.js';

const server = new DM();

await server.ready;
await server.run();
