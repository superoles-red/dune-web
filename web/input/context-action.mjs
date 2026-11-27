/* Contextual B action descriptor. The native side owns all guards/timers; this
 * only maps the read-only `dune_web_actions_debug` snapshot to a UI descriptor,
 * exactly like the old MIT web build (`Dune Sega Web/web/context-action.mjs`).
 *
 * Arming belongs to the explicit contextual command on the selected unit, so
 * the bottom row exposes only an already available original B action.
 */

const B_LABELS = {
  repeat: 'REPEAT',
  'confirm-devastator': 'DETONATE',
  'confirm-mcv': 'DEPLOY',
  'confirm-native': 'CONFIRM',
};

const B_ARIA = {
  repeat: 'Повторить производство',
  'confirm-devastator': 'Завершить отсчёт самоподрыва — оригинальная B',
  'confirm-mcv': 'Подтвердить развёртывание — оригинальная B',
  'confirm-native': 'Завершить особый отсчёт — оригинальная B',
};

/**
 * @param {object} actions read-only `dune_web_actions_debug` JSON
 * @returns {{method:'b', kind:string, label:string, aria:string}|null}
 */
export function contextAction(actions = {}) {
  if (actions.placementActive) return null;
  if (actions.bAvailable) {
    const kind = actions.bKind || 'confirm-native';
    return {
      method: 'b',
      kind,
      label: B_LABELS[kind] || 'ACTION',
      aria: B_ARIA[kind] || 'Действие оригинальной кнопки B',
    };
  }
  return null;
}
