// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `backrest`.
//
// The use case: a glance at the wall tablet tells whether the backups ran,
// and which one did not. So the widget shows the number of plans failed,
// overdue and OK, then one row per plan — failed first, then overdue, running,
// with warnings, never run, OK — with its state and its last success (or the
// progress of the one running).
//
// Every plan by default, or the ones chosen in the widget settings (devices
// added to Gladys). The figures are sent as values, not bound to device
// features: the widget works before the devices are added.
//
// Budget (8 components, 2 texts): three tiles, one text when Backrest does
// not answer, one status list of ten rows at most, a Refresh button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { stateOf } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { ERROR_TEXT, STATE_TEXT, formatTime, pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 10;

export const TEXT = {
  pick: {
    en: 'Enter the address of your Backrest in the configuration of the integration.',
    fr: "Saisissez l'adresse de votre Backrest dans la configuration de l'intégration.",
    de: 'Gib die Adresse deines Backrest in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de su Backrest en la configuración de la integración.',
  },
  empty: {
    en: 'No plan yet: create one in Backrest.',
    fr: 'Aucun plan pour le moment : créez-en un dans Backrest.',
    de: 'Noch kein Plan: Lege einen in Backrest an.',
    es: 'Todavía no hay ningún plan: cree uno en Backrest.',
  },
  failed: { en: 'Failed', fr: 'En échec', de: 'Fehlgeschlagen', es: 'Fallidos' },
  overdue: { en: 'Overdue', fr: 'En retard', de: 'Überfällig', es: 'Con retraso' },
  ok: { en: 'OK', fr: 'OK', de: 'OK', es: 'Correctos' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Backrest read again.',
    fr: 'Backrest relu.',
    de: 'Backrest neu gelesen.',
    es: 'Backrest leído de nuevo.',
  },
};

// Row order: what needs attention first.
const SEVERITY = ['failed', 'overdue', 'running', 'warning', 'never', 'ok'];

const ROW_STYLE = {
  failed: { icon: 'x-circle', color: WIDGET_COLORS.DANGER },
  overdue: { icon: 'clock', color: WIDGET_COLORS.WARNING },
  running: { icon: 'play-circle', color: WIDGET_COLORS.INFO },
  warning: { icon: 'alert-triangle', color: WIDGET_COLORS.WARNING },
  never: { icon: 'circle', color: WIDGET_COLORS.NEUTRAL },
  ok: { icon: 'check-circle', color: WIDGET_COLORS.SUCCESS },
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: pick(text, language) }],
  };
}

/** The plans the widget shows: the chosen devices, or every plan. */
export function selectPlans(hub, settings) {
  const chosen = [settings?.plans ?? []].flat().filter((id) => typeof id === 'string' && id);
  if (chosen.length === 0) {
    return [...hub.plans.values()];
  }
  return [...new Set(chosen)].map((id) => hub.find(id)).filter(Boolean);
}

export function sortPlans(plans) {
  return [...plans].sort(
    (a, b) =>
      SEVERITY.indexOf(stateOf(a)) - SEVERITY.indexOf(stateOf(b)) || a.id.localeCompare(b.id),
  );
}

function rowValue(hub, plan, language) {
  const state = stateOf(plan);
  const text = pick(STATE_TEXT[state], language);
  if (state === 'running') {
    return plan.progress === null ? text : `${text} · ${plan.progress} %`;
  }
  return plan.lastSuccess === null ? text : `${text} · ${formatTime(plan.lastSuccess, language)}`;
}

async function get(hub, { settings, language = 'en' }) {
  if (!hub.client) {
    return message(TEXT.pick, language);
  }
  const plans = sortPlans(selectPlans(hub, settings));
  if (plans.length === 0 && !hub.error) {
    return message(TEXT.empty, language);
  }

  const failed = plans.filter((plan) => plan.lastRun?.result === 'error').length;
  const overdue = plans.filter((plan) => plan.overdue).length;
  const ok = plans.filter((plan) => ['ok', 'warning'].includes(stateOf(plan))).length;
  const components = [
    {
      type: 'value',
      value: failed,
      label: pick(TEXT.failed, language),
      icon: 'x-circle',
      color: failed > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: overdue,
      label: pick(TEXT.overdue, language),
      icon: 'clock',
      color: overdue > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: ok,
      label: pick(TEXT.ok, language),
      icon: 'check-circle',
      color: WIDGET_COLORS.SUCCESS,
    },
  ];

  if (hub.error) {
    components.push({
      type: 'text',
      variant: 'body',
      text: pick(ERROR_TEXT[hub.error.kind], language),
    });
  }

  if (plans.length > 0) {
    const shown = plans.length > MAX_ROWS ? plans.slice(0, MAX_ROWS - 1) : plans;
    const items = shown.map((plan) => ({
      label: fit(plan.id, 40),
      value: fit(rowValue(hub, plan, language), 40),
      ...ROW_STYLE[stateOf(plan)],
    }));
    if (plans.length > shown.length) {
      items.push({
        label: pick(TEXT.more, language),
        value: `+${plans.length - shown.length}`,
        icon: 'more-horizontal',
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
    components.push({ type: 'status', items });
  }

  components.push({
    type: 'button',
    label: pick(TEXT.refresh, language),
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: ACTIONS.REFRESH },
  });

  // A backup running moves: refresh sooner.
  return { ttl_seconds: hub.error || hub.activeId ? 30 : 120, components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  await hub.pollNow();
  if (hub.error) {
    return { message: ERROR_TEXT[hub.error.kind] };
  }
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
