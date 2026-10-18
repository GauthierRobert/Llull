/** PHY-07 fatigue commands (crack initiation). */

import { commandCatalog } from '@core/commands/schema';
import { createFatigueCase, deleteFatigueCase, setFatigueFactors, updateFatigueCase } from './caseCommands';
import { checkFatigue, computeFatigue } from './computeFatigue';
import { countCycles } from './countCycles';
import { fatigueLife } from './fatigueLife';
import { defineLoadHistory, deleteLoadHistory, updateLoadHistory } from './historyCommands';

export const fatigueCommands = commandCatalog(
  defineLoadHistory,
  updateLoadHistory,
  deleteLoadHistory,
  countCycles,
  createFatigueCase,
  updateFatigueCase,
  deleteFatigueCase,
  setFatigueFactors,
  fatigueLife,
  computeFatigue,
  checkFatigue,
);
