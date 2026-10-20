// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "Is this plan failed?" is already a scene condition on the device
// features. The reading action is about what a condition cannot do: put the
// state in a message ("documents: failed, last success 18/10 02:05"). It
// reads Backrest again when the last read is older than 15 seconds.
//
// "Start a backup" can be disabled in the configuration: a scene, a voice
// assistant or another user of Gladys then cannot start one.
//
// Keys, outputs and behaviour are the ones of guim31/gladys-duplicati.
// -----------------------------------------------------------------------------

import { hoursSince, stateOf } from './devices.js';
import { SENTENCE_TEXT, STATE_TEXT, formatTime, labelled, pick } from './texts.js';

export const SCENE_ACTIONS = {
  async get_backup_status(hub, { fields = {} }) {
    const plan = await hub.planOf(fields.device);
    const language = hub.config.language;
    const state = stateOf(plan);
    const stateText = pick(STATE_TEXT[state], language);
    const lastSuccess = plan.lastSuccess === null ? '' : formatTime(plan.lastSuccess, language);
    const words = SENTENCE_TEXT[language] ?? SENTENCE_TEXT.en;
    return {
      failed: plan.lastRun?.result === 'error',
      overdue: plan.overdue,
      state: stateText,
      name: plan.id,
      last_success: lastSuccess,
      hours_since_success: hoursSince(plan, hub.now()) ?? -1,
      sentence: `${labelled(plan.id, stateText, language)}, ${
        lastSuccess ? words.lastSuccess(lastSuccess) : words.never
      }.`,
    };
  },

  async start_backup(hub, { fields = {} }) {
    await hub.startBackup(await hub.planOf(fields.device));
  },
};
