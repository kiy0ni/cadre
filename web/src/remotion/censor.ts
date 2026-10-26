// Swear words: one letter replaced with * in the text (if the style asks for it), and detection for the audio bleep.
// List taken from the engine (studio/engine.py, CENSOR_WORDS).
export const CENSOR_WORDS: Record<string, string> = {
  putain: 'p*tain', putains: 'p*tains', merde: 'm*rde', merdes: 'm*rdes', emmerde: 'emm*rde', emmerdes: 'emm*rdes',
  emmerder: 'emm*rder', 'bâtard': 'b*tard', 'bâtards': 'b*tards', batard: 'b*tard', batards: 'b*tards',
  'enculé': 'enc*lé', 'enculés': 'enc*lés', enculer: 'enc*ler', enculez: 'enc*lez', connard: 'c*nnard', connards: 'c*nnards',
  connasse: 'c*nnasse', salope: 'sal*pe', salopes: 'sal*pes', salaud: 'sal*ud', nique: 'n*que', niquer: 'n*quer',
  'niqué': 'n*qué', niquez: 'n*quez', niquais: 'n*quais', niquait: 'n*quait', pute: 'p*te', putes: 'p*tes',
  couilles: 'c*uilles', couille: 'c*uille', fuck: 'f*ck', fucking: 'f*cking', shit: 'sh*t',
  con: 'c*n', cons: 'c*ns', conne: 'c*nne', 'enfoirés': 'enf*irés', 'enfoiré': 'enf*iré', salopard: 'sal*pard',
  pouffiasse: 'pouf*iasse', poufiasse: 'pouf*asse', chienne: 'ch*enne', fdp: 'f*p',
};

const CORE = /^([^\p{L}\p{N}]*)([\p{L}\p{N}'’-]+)([^\p{L}\p{N}]*)$/u;

export function censorToken(tok: string): string {
  const m = tok.match(CORE);
  if (!m) return tok;
  const [, pre, core, post] = m;
  const low = core.toLowerCase();
  for (const sep of ["'", '’']) {
    if (low.includes(sep)) {
      const [a, b] = low.split(sep, 2);
      if (CENSOR_WORDS[b]) return pre + core.slice(0, a.length + 1) + CENSOR_WORDS[b] + post;
    }
  }
  if (CENSOR_WORDS[low]) {
    const rep = CENSOR_WORDS[low];
    return pre + (core === core.toUpperCase() ? rep.toUpperCase() : rep) + post;
  }
  return tok;
}

export function censorText(text: string): string {
  return text.split(/(\s+)/).map((t) => (/\s/.test(t) ? t : censorToken(t))).join('');
}

export function isSwear(word: string): boolean {
  const low = word.trim().toLowerCase().replace(/[^\p{L}'’-]/gu, '');
  if (CENSOR_WORDS[low]) return true;
  for (const sep of ["'", '’']) {
    if (low.includes(sep) && CENSOR_WORDS[low.split(sep, 2)[1]]) return true;
  }
  return low.includes('*') || word.includes('__');
}
