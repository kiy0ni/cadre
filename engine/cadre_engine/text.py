"""Subtitle text rules: swear words (one letter replaced by *), words never to leave at the end of a line.
The word lists are language data (French and English) and stay as they are."""
import re

CENSOR = {
    # French
    'putain': 'p*tain', 'putains': 'p*tains', 'merde': 'm*rde', 'merdes': 'm*rdes', 'emmerde': 'emm*rde', 'emmerder': 'emm*rder',
    'bâtard': 'b*tard', 'bâtards': 'b*tards', 'batard': 'b*tard', 'batards': 'b*tards', 'enculé': 'enc*lé', 'enculés': 'enc*lés',
    'enculer': 'enc*ler', 'connard': 'c*nnard', 'connards': 'c*nnards', 'connasse': 'c*nnasse', 'salope': 'sal*pe', 'salopes': 'sal*pes',
    'salaud': 'sal*ud', 'nique': 'n*que', 'niquer': 'n*quer', 'niqué': 'n*qué', 'pute': 'p*te', 'putes': 'p*tes', 'couilles': 'c*uilles',
    'couille': 'c*uille', 'con': 'c*n', 'cons': 'c*ns', 'conne': 'c*nne', 'enfoiré': 'enf*iré', 'enfoirés': 'enf*irés',
    'salopard': 'sal*pard', 'pouffiasse': 'pouf*iasse', 'fdp': 'f*p', 'bordel': 'b*rdel',
    # English
    'fuck': 'f*ck', 'fucking': 'f*cking', 'fucked': 'f*cked', 'shit': 'sh*t', 'bitch': 'b*tch', 'asshole': 'a**hole',
    'motherfucker': 'motherf*cker', 'dick': 'd*ck', 'bullshit': 'bullsh*t',
}

NOEND = {
    # French: articles, pronouns, prepositions… never alone at the end of a subtitle
    'ils', 'elles', 'nous', 'vous', 'le', 'la', 'les', 'un', 'une', 'de', 'du', 'des', 'à', 'au', 'aux', 'en', 'et', 'je', 'tu', 'il',
    'elle', 'on', 'ce', 'ma', 'mon', 'ta', 'ton', 'sa', 'son', 'ses', 'mes', 'tes', 'que', 'qui', 'pour', 'par', 'sur', 'dans', 'avec',
    'très', 'plus', 'pas', "j'ai", "c'est", "t'es", 'est', 'suis', 'ne', 'me', 'te', 'se', 'y', 'mais', 'parce',
    # English
    'the', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'for', 'with', 'my', 'your', 'i', "i'm", 'is', 'are', 'but', 'so', 'that',
}
BREAK_BEFORE = {'mais', 'parce', 'et', 'donc', 'alors', 'sauf', 'genre', 'comme', 'quand', 'si', 'puis', 'pour', 'que', 'qui',
                'but', 'because', 'and', 'so', 'when', 'if', 'then', 'which'}
FILLERS = {'euh', 'heu', 'hum', 'hmm', 'euhh', 'bah', 'ben', 'uh', 'um', 'uhm', 'erm'}

_CORE = re.compile(r"^([^\wÀ-ÿ]*)([\wÀ-ÿ'’-]+)([^\wÀ-ÿ]*)$")


def clean_word(t):
    """swear word -> one letter replaced by *"""
    t = t.strip()
    m = _CORE.match(t)
    if not m: return t
    pre, core, post = m.groups()
    low = core.lower()
    for sep in ("'", '’'):
        if sep in low:
            a, b = low.split(sep, 1)
            if b in CENSOR: return pre + core[:len(a) + 1] + CENSOR[b] + post
    if low in CENSOR:
        rep = CENSOR[low]
        return pre + (rep.upper() if core.isupper() and len(core) > 1 else rep) + post
    return t


def is_swear(w):
    low = re.sub(r"[^\wà-ÿ'’-]", '', w.strip().lower())
    if low in CENSOR: return True
    return any(sep in low and low.split(sep, 1)[1] in CENSOR for sep in ("'", '’'))
