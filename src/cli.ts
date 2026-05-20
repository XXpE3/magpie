#!/usr/bin/env node
import { Command } from 'commander'
import { createRequire } from 'node:module'
import { reviewCommand } from './commands/review.js'
import { initCommand } from './commands/init.js'
import { discussCommand } from './commands/discuss.js'
import { statsCommand } from './commands/stats.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

const program = new Command()

program
  .name('magpie')
  .description('Multi-AI adversarial PR review tool')
  .version(version)

program.addCommand(reviewCommand)
program.addCommand(initCommand)
program.addCommand(discussCommand)
program.addCommand(statsCommand)

program.parse()
