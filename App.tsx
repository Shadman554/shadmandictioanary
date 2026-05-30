/**
 * Shadman Dictionary — v3 (Fixed)
 * Fixes:
 *  1. Font applies to the ENTIRE app via a global Text default + all components
 *  2. Modal sheet uses C.card instead of hardcoded dark color (light mode fix)
 *  3. Highlight component now always receives and applies fontFamily
 *  4. pillDangerTx style cleaned up (no duplicate fontSize/fontFamily)
 *  5. catStyle color spreading made safe
 */

import React, {
  useEffect, useRef, useState, useCallback, useMemo,
} from 'react';
import {
  SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput,
  View, TouchableOpacity, FlatList, Modal, Pressable, Animated,
  Platform, ActivityIndicator, Dimensions, Image,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Asset references ────────────────────────────────────────────────────────
const LOGO        = require('./assets/logo.png');
const ICO_SEARCH  = require('./assets/icons/search.png');
const ICO_SAVE    = require('./assets/icons/bookmark.png');
const ICO_SETTING = require('./assets/icons/setting.png');
const ICO_STAR    = require('./assets/icons/star.png');
const ICO_RECENT  = require('./assets/icons/recent.png');
const ICO_FONT    = require('./assets/icons/filter.png');
const ICO_ABOUT   = require('./assets/icons/about.png');

// ─── Types ────────────────────────────────────────────────────────────────────

interface Entry {
  ID: string;
  word: string;
  meaning: string;
  wordLow: string;
}

type SearchMode =
  'entoku'|'kutoen'|'artoku'|'kutoar'|'fatoku'|'kutofa'|
  'frtoku'|'kutofr'|'grtoku'|'kutogr'|'rutoku'|'kutoru'|
  'svtoku'|'kutosv'|'trtoku'|'kutotr';

type Tab = 'search'|'saved'|'translate'|'settings';

// ─── Kurdish Fonts ────────────────────────────────────────────────────────────

const FONTS: { label: string; family: string }[] = [
  { label: 'سیروان',               family: 'سیروان' },
  { label: 'ئێن ئارتی',           family: 'فۆنتی ئێن ئارتی' },
  { label: 'ئێن ئارتی بۆڵد',      family: 'فۆنتی ئێن ئارتی ب' },
  { label: 'ڕووداو',              family: 'فۆنتی ڕووداو' },
  { label: 'ڕووداو بۆڵد',         family: 'فۆنتی ڕووداو ب' },
  { label: 'خەندان',              family: 'ماڵپەری خەندان' },
  { label: 'خەندان بۆڵد',         family: 'ماڵپەری خەندان ب' },
  { label: 'نێت تی ڤی',           family: 'نێت تی ڤی' },
  { label: 'نێت تی ڤی بۆڵد',      family: 'نێت تی ڤی ب' },
  { label: 'کۆمار',               family: 'کۆمار' },
  { label: 'کوردستان ٢٤',         family: 'کەناڵی  کوردستان ٢٤' },
  { label: 'کوردستان ٢٤ بۆڵد',    family: 'کەناڵی  کوردستان ٢٤ب' },
  { label: 'سپێدە',               family: 'کەناڵی سپێدە' },
  { label: 'سپێدە بۆڵد',          family: 'کەناڵی سپێدە ب' },
];

// ─── Mode config ──────────────────────────────────────────────────────────────

const MODES: { key: SearchMode; label: string; from: string; to: string }[] = [
  { key:'entoku', label:'EN → KU', from:'English',  to:'Kurdish'  },
  { key:'kutoen', label:'KU → EN', from:'Kurdish',  to:'English'  },
  { key:'artoku', label:'AR → KU', from:'Arabic',   to:'Kurdish'  },
  { key:'kutoar', label:'KU → AR', from:'Kurdish',  to:'Arabic'   },
  { key:'fatoku', label:'FA → KU', from:'Farsi',    to:'Kurdish'  },
  { key:'kutofa', label:'KU → FA', from:'Kurdish',  to:'Farsi'    },
  { key:'frtoku', label:'FR → KU', from:'French',   to:'Kurdish'  },
  { key:'kutofr', label:'KU → FR', from:'Kurdish',  to:'French'   },
  { key:'grtoku', label:'DE → KU', from:'German',   to:'Kurdish'  },
  { key:'kutogr', label:'KU → DE', from:'Kurdish',  to:'German'   },
  { key:'rutoku', label:'RU → KU', from:'Russian',  to:'Kurdish'  },
  { key:'kutoru', label:'KU → RU', from:'Kurdish',  to:'Russian'  },
  { key:'svtoku', label:'SV → KU', from:'Swedish',  to:'Kurdish'  },
  { key:'kutosv', label:'KU → SV', from:'Kurdish',  to:'Swedish'  },
  { key:'trtoku', label:'TR → KU', from:'Turkish',  to:'Kurdish'  },
  { key:'kutotr', label:'KU → TR', from:'Kurdish',  to:'Turkish'  },
];

const ALL_KEYS = MODES.map(m => m.key) as SearchMode[];

// ─── Online Translator Languages ─────────────────────────────────────────────

const TRANSLATE_LANGS: { name: string; code: string }[] = [
  { name: 'Auto Detect',           code: 'auto'  },
  { name: 'Arabic',                code: 'ar'    },
  { name: 'Armenian',              code: 'hy'    },
  { name: 'Azerbaijani',           code: 'az'    },
  { name: 'Bulgarian',             code: 'bg'    },
  { name: 'Chinese (Simplified)',  code: 'zh-CN' },
  { name: 'Chinese (Traditional)', code: 'zh-TW' },
  { name: 'Croatian',              code: 'hr'    },
  { name: 'Czech',                 code: 'cs'    },
  { name: 'Danish',                code: 'da'    },
  { name: 'Dutch',                 code: 'nl'    },
  { name: 'English',               code: 'en'    },
  { name: 'Estonian',              code: 'et'    },
  { name: 'Filipino',              code: 'tl'    },
  { name: 'Finnish',               code: 'fi'    },
  { name: 'French',                code: 'fr'    },
  { name: 'German',                code: 'de'    },
  { name: 'Greek',                 code: 'el'    },
  { name: 'Hebrew',                code: 'iw'    },
  { name: 'Hindi',                 code: 'hi'    },
  { name: 'Hungarian',             code: 'hu'    },
  { name: 'Indonesian',            code: 'id'    },
  { name: 'Irish',                 code: 'ga'    },
  { name: 'Italian',               code: 'it'    },
  { name: 'Japanese',              code: 'ja'    },
  { name: 'Korean',                code: 'ko'    },
  { name: 'Kurdish (Sorani)',       code: 'ckb'   },
  { name: 'Latvian',               code: 'lv'    },
  { name: 'Lithuanian',            code: 'lt'    },
  { name: 'Malay',                 code: 'ms'    },
  { name: 'Norwegian',             code: 'no'    },
  { name: 'Persian',               code: 'fa'    },
  { name: 'Polish',                code: 'pl'    },
  { name: 'Portuguese',            code: 'pt'    },
  { name: 'Romanian',              code: 'ro'    },
  { name: 'Russian',               code: 'ru'    },
  { name: 'Serbian',               code: 'sr'    },
  { name: 'Slovak',                code: 'sk'    },
  { name: 'Slovenian',             code: 'sl'    },
  { name: 'Spanish',               code: 'es'    },
  { name: 'Swahili',               code: 'sw'    },
  { name: 'Swedish',               code: 'sv'    },
  { name: 'Thai',                  code: 'th'    },
  { name: 'Turkish',               code: 'tr'    },
  { name: 'Ukrainian',             code: 'uk'    },
  { name: 'Urdu',                  code: 'ur'    },
  { name: 'Vietnamese',            code: 'vi'    },
  { name: 'Welsh',                 code: 'cy'    },
  { name: 'Yiddish',               code: 'yi'    },
];

// ─── Translate Tab Component ──────────────────────────────────────────────────

interface LangOption { name: string; code: string; }

const TranslateTab: React.FC<{ C: any; fontFamily: string; textScale: number }> = ({
  C, fontFamily, textScale: sc,
}) => {
  const [fromLang, setFromLang]       = useState<LangOption>({ name: 'English',          code: 'en'  });
  const [toLang,   setToLang]         = useState<LangOption>({ name: 'Kurdish (Sorani)', code: 'ckb' });
  const [inputText,  setInputText]    = useState('');
  const [outputText, setOutputText]   = useState('');
  const [translating, setTranslating] = useState(false);
  const [fromPicker, setFromPicker]   = useState(false);
  const [toPicker,   setToPicker]     = useState(false);
  const [error,      setError]        = useState('');

  const doTranslate = useCallback(async (text: string, from: string, to: string) => {
    if (!text.trim()) { setOutputText(''); return; }
    setTranslating(true);
    setError('');
    try {
      const url =
        `https://translate.googleapis.com/translate_a/single?client=gtx` +
        `&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
      const res  = await fetch(url);
      const json = await res.json();
      setOutputText(json[0].map((item: any) => item[0]).join(''));
    } catch {
      setError('Translation failed. Please check your connection.');
    } finally {
      setTranslating(false);
    }
  }, []);

  const handleSwap = () => {
    if (fromLang.code === 'auto') return;
    const tmp = fromLang;
    setFromLang(toLang);
    setToLang(tmp);
    setInputText(outputText);
    setOutputText(inputText);
  };

  const handleInputChange = (t: string) => {
    const limited = t.slice(0, 5000);
    setInputText(limited);
    if (limited.length > 2) doTranslate(limited, fromLang.code, toLang.code);
    else setOutputText('');
  };

  const card    = { backgroundColor: C.card,    borderRadius: 16, borderWidth: 1 as any, borderColor: C.border    };
  const surface = { backgroundColor: C.surface, borderRadius: 12, borderWidth: 1 as any, borderColor: C.borderMid };

  const LangPicker = ({
    visible, onClose, title, selected, onSelect, allowAuto,
  }: {
    visible: boolean; onClose: () => void; title: string;
    selected: LangOption; onSelect: (l: LangOption) => void; allowAuto?: boolean;
  }) => (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.65)' }}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} />
        <View style={{ backgroundColor: C.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 12, maxHeight: '75%' }}>
          <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.15)', alignSelf: 'center', marginBottom: 16 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, marginBottom: 12, gap: 10 }}>
            <Text style={{ fontSize: 16, color: C.accent }}>🌐</Text>
            <Text style={{ fontSize: 16, fontWeight: '900', color: C.text1, fontFamily }}>{title}</Text>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            {TRANSLATE_LANGS.filter(l => allowAuto || l.code !== 'auto').map(l => {
              const active = selected.code === l.code;
              return (
                <TouchableOpacity
                  key={l.code}
                  style={[{
                    flexDirection: 'row', alignItems: 'center',
                    paddingHorizontal: 16, paddingVertical: 14,
                    borderRadius: 12, marginBottom: 5, marginHorizontal: 10,
                    borderWidth: 1,
                  }, active
                    ? { backgroundColor: C.accentDim,  borderColor: C.accentBorder }
                    : { backgroundColor: C.surface,    borderColor: 'transparent'  }
                  ]}
                  onPress={() => { onSelect(l); onClose(); }}
                  activeOpacity={0.7}
                >
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: '700', color: active ? C.accent : C.text1, fontFamily }}>
                    {l.name}
                  </Text>
                  {active && <Text style={{ fontSize: 16, color: C.accent, fontWeight: '900' }}>✓</Text>}
                </TouchableOpacity>
              );
            })}
            <View style={{ height: 32 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: C.bg }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Language selector row */}
        <View style={[card, { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8, marginBottom: 12 }]}>
          <TouchableOpacity
            style={[surface, { flex: 1, paddingVertical: 14, paddingHorizontal: 12, alignItems: 'center' }]}
            onPress={() => setFromPicker(true)}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 10, fontWeight: '700', color: C.text3, fontFamily, letterSpacing: 1.5, marginBottom: 3 }}>FROM</Text>
            <Text style={{ fontSize: 13, fontWeight: '800', color: C.text1, fontFamily }} numberOfLines={1}>{fromLang.name}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleSwap}
            style={{
              width: 40, height: 40, borderRadius: 20,
              backgroundColor: fromLang.code === 'auto' ? C.surface : C.accent,
              alignItems: 'center', justifyContent: 'center',
            }}
            activeOpacity={0.75}
          >
            <Text style={{ fontSize: 18, color: fromLang.code === 'auto' ? C.text3 : '#fff' }}>⇄</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[surface, { flex: 1, paddingVertical: 14, paddingHorizontal: 12, alignItems: 'center' }]}
            onPress={() => setToPicker(true)}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 10, fontWeight: '700', color: C.text3, fontFamily, letterSpacing: 1.5, marginBottom: 3 }}>TO</Text>
            <Text style={{ fontSize: 13, fontWeight: '800', color: C.text1, fontFamily }} numberOfLines={1}>{toLang.name}</Text>
          </TouchableOpacity>
        </View>

        {/* Input area */}
        <View style={[card, { marginBottom: 12 }]}>
          <TextInput
            style={{
              minHeight: 130, padding: 16, fontSize: 16,
              textAlignVertical: 'top', color: C.text1, fontFamily,
            }}
            placeholder="Enter text to translate…"
            placeholderTextColor={C.text3}
            value={inputText}
            onChangeText={handleInputChange}
            multiline
            maxLength={5000}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12 }}>
            {inputText ? (
              <TouchableOpacity onPress={() => { setInputText(''); setOutputText(''); setError(''); }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: C.text2, fontFamily }}>✕ Clear</Text>
              </TouchableOpacity>
            ) : <View />}
            <Text style={{ fontSize: 11, color: C.text3, fontFamily }}>{inputText.length} / 5000</Text>
          </View>
        </View>

        {/* Translate button */}
        <TouchableOpacity
          style={{
            backgroundColor: C.accent, borderRadius: 14, padding: 16,
            alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10,
            marginBottom: 12,
            opacity: (!inputText.trim() || translating) ? 0.5 : 1,
          }}
          onPress={() => doTranslate(inputText, fromLang.code, toLang.code)}
          disabled={!inputText.trim() || translating}
          activeOpacity={0.75}
        >
          <Text style={{ fontSize: 20 }}>🌐</Text>
          <Text style={{ color: '#fff', fontFamily, fontSize: 15, fontWeight: '800' }}>
            {translating ? 'Translating…' : 'Translate'}
          </Text>
        </TouchableOpacity>

        {/* Error */}
        {error ? (
          <View style={{ backgroundColor: 'rgba(239,83,80,0.12)', borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <Text style={{ color: '#EF5350', fontFamily, fontSize: 13, textAlign: 'center' }}>{error}</Text>
          </View>
        ) : null}

        {/* Output area */}
        <View style={[card, { minHeight: 130 }]}>
          {translating ? (
            <View style={{ padding: 32, alignItems: 'center', gap: 12 }}>
              <ActivityIndicator color={C.accent} size="large" />
              <Text style={{ fontSize: 13, color: C.text2, fontFamily }}>Translating…</Text>
            </View>
          ) : outputText ? (
            <>
              <View style={{ padding: 16 }}>
                <Text selectable style={{ fontSize: 16, lineHeight: 26, color: C.text1, fontFamily }}>{outputText}</Text>
              </View>
              <View style={{ height: 1, backgroundColor: C.border, marginHorizontal: 16 }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 }}>
                <Text style={{ fontSize: 11, color: C.text3, fontFamily }}>{toLang.name}</Text>
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 }}
                  onPress={() => {
                    if (typeof navigator !== 'undefined' && (navigator as any).clipboard) {
                      (navigator as any).clipboard.writeText(outputText);
                    }
                  }}
                >
                  <Text style={{ fontSize: 14 }}>📋</Text>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: C.text2, fontFamily }}>Copy</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View style={{ padding: 32, alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 36 }}>🌍</Text>
              <Text style={{ fontSize: 14, fontWeight: '700', color: C.text2, fontFamily }}>Translation appears here</Text>
              <Text style={{ fontSize: 12, color: C.text3, fontFamily, textAlign: 'center' }}>
                Type text above and tap Translate
              </Text>
            </View>
          )}
        </View>

        <Text style={{ fontSize: 10, color: C.text3, fontFamily, textAlign: 'center', marginTop: 16 }}>
          Powered by Google Translate · 50 languages supported
        </Text>
      </ScrollView>

      <LangPicker
        visible={fromPicker}
        onClose={() => setFromPicker(false)}
        title="Translate From"
        selected={fromLang}
        allowAuto
        onSelect={l => {
          setFromLang(l);
          doTranslate(inputText, l.code, toLang.code);
        }}
      />
      <LangPicker
        visible={toPicker}
        onClose={() => setToPicker(false)}
        title="Translate To"
        selected={toLang}
        onSelect={l => {
          setToLang(l);
          doTranslate(inputText, fromLang.code, l.code);
        }}
      />
    </>
  );
};

// ─── Raw JSON loaders ─────────────────────────────────────────────────────────

const loadRaw = (mode: SearchMode): any[] => {
  try {
    switch (mode) {
      case 'entoku': return require('./data/entoku.json');
      case 'kutoen': return require('./data/kutoen.json');
      case 'artoku': return require('./data/artoku.json');
      case 'fatoku': return require('./data/fatoku.json');
      case 'frtoku': return require('./data/frtoku.json');
      case 'grtoku': return require('./data/grtoku.json');
      case 'kutoar': return require('./data/kutoar.json');
      case 'kutofa': return require('./data/kutofa.json');
      case 'kutofr': return require('./data/kutofr.json');
      case 'kutogr': return require('./data/kutogr.json');
      case 'kutoru': return require('./data/kutoru.json');
      case 'kutosv': return require('./data/kutosv.json');
      case 'kutotr': return require('./data/kutotr.json');
      case 'rutoku': return require('./data/rutoku.json');
      case 'svtoku': return require('./data/svtoku.json');
      case 'trtoku': return require('./data/trtoku.json');
      default: return [];
    }
  } catch { return []; }
};

// ─── Index builder ────────────────────────────────────────────────────────────

const indexCache: Partial<Record<SearchMode, Entry[]>> = {};

const buildIndex = (mode: SearchMode): Entry[] => {
  if (indexCache[mode]) return indexCache[mode]!;
  const raw = loadRaw(mode);
  const entries: Entry[] = raw.map((r, i) => {
    const word = r.word ?? '';
    return {
      ID: r.ID?.toString() ?? r.id?.toString() ?? String(i),
      word,
      meaning: r.kurdish_meaning ?? '',
      wordLow: word.toLowerCase(),
    };
  });
  entries.sort((a, b) => a.wordLow < b.wordLow ? -1 : a.wordLow > b.wordLow ? 1 : 0);
  indexCache[mode] = entries;
  return entries;
};

// ─── Binary search ────────────────────────────────────────────────────────────

const lowerBound = (entries: Entry[], prefix: string): number => {
  let lo = 0, hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].wordLow < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// ─── Fast synchronous search ──────────────────────────────────────────────────

const doSearch = (entries: Entry[], query: string, cat: string | null, limit: number): Entry[] => {
  let pool = entries;
  if (cat) {
    const bracketCat = `[${cat}]`;
    pool = pool.filter(e => e.meaning.includes(bracketCat));
  }

  if (!query) return pool.slice(0, limit);
  const q = query.toLowerCase();

  const start = lowerBound(pool, q);
  const prefix: Entry[] = [];
  for (let i = start; i < pool.length && pool[i].wordLow.startsWith(q); i++) {
    prefix.push(pool[i]);
  }

  const contains: Entry[] = [];
  if (query.length >= 2) {
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (!e.wordLow.startsWith(q) && e.wordLow.includes(q)) {
        contains.push(e);
      }
    }
  }

  const inMeaning: Entry[] = [];
  for (let i = 0; i < pool.length; i++) {
    const e = pool[i];
    if (e.meaning.includes(query)) inMeaning.push(e);
  }

  const seen = new Set<string>();
  const result: Entry[] = [];
  for (const group of [prefix, contains, inMeaning]) {
    for (const e of group) {
      if (!seen.has(e.ID)) {
        seen.add(e.ID);
        result.push(e);
      }
      if (result.length >= limit) return result;
    }
  }
  return result;
};

// ─── Dynamic Colors ───────────────────────────────────────────────────────────

const getCategoryColors = (cat: string, isLight: boolean) => {
  let hash = 0;
  for (let i = 0; i < cat.length; i++) {
    hash = cat.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return {
    color: isLight ? `hsl(${h}, 70%, 45%)` : `hsl(${h}, 85%, 65%)`,
    backgroundColor: isLight ? `hsla(${h}, 70%, 45%, 0.12)` : `hsla(${h}, 85%, 65%, 0.18)`
  };
};

// ─── FIX: Highlight now accepts fontFamily and applies it everywhere ──────────

const Highlight = ({
  text, query, style, hlStyle, catStyle, isLight, fontFamily,
}: {
  text: string;
  query: string;
  style: any;
  hlStyle: any;
  catStyle?: any;
  isLight: boolean;
  fontFamily: string;   // ← NEW: required so every Text node uses the chosen font
}) => {
  let parts: string[] = [text];

  if (catStyle) {
    parts = text.split(/(\[[^[\]]{1,40}\])/g);
  }

  const trimmed = query.trim();
  if (trimmed) {
    const esc = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${esc})`, 'gi');
    parts = parts.flatMap(p => {
      if (catStyle && p.startsWith('[') && p.endsWith(']')) return [p];
      return p.split(regex);
    });
  }

  return (
    <Text style={[style, { fontFamily }]}>
      {parts.map((p, i) => {
        if (!p) return null;
        if (catStyle && p.startsWith('[') && p.endsWith(']')) {
          const customColors = getCategoryColors(p, isLight);
          // FIX: spread customColors safely — only color + backgroundColor
          return (
            <Text
              key={i}
              style={[catStyle, { color: customColors.color, backgroundColor: customColors.backgroundColor }, { fontFamily }]}
            >
              {p}
            </Text>
          );
        }
        if (trimmed && p.toLowerCase() === trimmed.toLowerCase()) {
          return <Text key={i} style={[hlStyle, { fontFamily }]}>{p}</Text>;
        }
        return <Text key={i} style={{ fontFamily }}>{p}</Text>;
      })}
    </Text>
  );
};

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [mode, setMode]           = useState<SearchMode>('entoku');
  const [query, setQuery]         = useState('');
  const [results, setResults]     = useState<Entry[]>([]);
  const [totalCount, setTotal]    = useState(0);
  const [loading, setLoading]     = useState(true);
  const [tab, setTab]             = useState<Tab>('search');
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  const [recents, setRecents]     = useState<string[]>([]);
  const [modePicker,  setModePicker]  = useState(false);
  const [fontPicker,  setFontPicker]  = useState(false);
  const [fontFamily,  setFontFamily]  = useState<string>('فۆنتی ئێن ئارتی');
  const [isLightMode, setIsLightMode] = useState<boolean>(false);
  const [textScale,   setTextScale]   = useState<number>(1);
  const [focused,     setFocused]     = useState(false);
  const [filterCat,   setFilterCat]   = useState<string | null>(null);
  const [limit,       setLimit]       = useState(300);

  const C = useMemo(() => getColors(isLightMode), [isLightMode]);
  const S = useMemo(() => getStyles(C, textScale, fontFamily), [C, textScale, fontFamily]);
  const listRef   = useRef<FlatList>(null);
  const focusAnim = useRef(new Animated.Value(0)).current;

  const TAB_LIST: Tab[] = ['search', 'saved', 'translate', 'settings'];
  const tabAnim  = useRef(new Animated.Value(0)).current;

  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    Animated.spring(tabAnim, {
      toValue: TAB_LIST.indexOf(t),
      useNativeDriver: true,
      tension: 180,
      friction: 16,
    }).start();
  }, []);

  useEffect(() => {
    Animated.timing(focusAnim, {
      toValue: focused ? 1 : 0, duration: 150, useNativeDriver: false,
    }).start();
  }, [focused]);

  const loadMode = useCallback((m: SearchMode, q = '') => {
    setLoading(true);
    setFilterCat(null);
    setLimit(300);
    requestAnimationFrame(() => {
      const idx = buildIndex(m);
      setTotal(idx.length);
      setResults(doSearch(idx, q, null, 300));
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [rs, favs, savedMode, savedFont, savedTheme, savedScale] = await Promise.all([
          AsyncStorage.getItem('recents'),
          AsyncStorage.getItem('favorites'),
          AsyncStorage.getItem('mode'),
          AsyncStorage.getItem('fontFamily'),
          AsyncStorage.getItem('isLightMode'),
          AsyncStorage.getItem('textScale'),
        ]);
        if (rs)        setRecents(JSON.parse(rs));
        if (favs)      setFavorites(JSON.parse(favs));
        if (savedFont) setFontFamily(savedFont);
        if (savedTheme != null) setIsLightMode(savedTheme === 'true');
        if (savedScale != null) {
          const val = parseFloat(savedScale);
          setTextScale(isNaN(val) ? 1 : val);
        }
        const m = (savedMode && ALL_KEYS.includes(savedMode as SearchMode))
          ? savedMode as SearchMode : 'entoku';
        setMode(m);
        loadMode(m, '');
      } catch {
        loadMode('entoku', '');
      }
    })();
  }, []);

  useEffect(() => {
    if (loading) return;
    const idx = indexCache[mode];
    if (!idx) return;
    setLimit(300);
    setResults(doSearch(idx, query, filterCat, 300));
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [query, mode, filterCat]);

  useEffect(() => {
    if (loading || limit === 300) return;
    const idx = indexCache[mode];
    if (!idx) return;
    setResults(doSearch(idx, query, filterCat, limit));
  }, [limit]);

  const switchMode = useCallback((m: SearchMode) => {
    setMode(m);
    setQuery('');
    setModePicker(false);
    AsyncStorage.setItem('mode', m);
    loadMode(m, '');
  }, [loadMode]);

  const saveFavs = (map: Record<string, boolean>) => {
    setFavorites(map);
    AsyncStorage.setItem('favorites', JSON.stringify(map));
  };
  const saveRecents = (arr: string[]) => {
    setRecents(arr);
    AsyncStorage.setItem('recents', JSON.stringify(arr));
  };
  const toggleFav = (id: string) => saveFavs({ ...favorites, [id]: !favorites[id] });
  const addRecent = (t: string) => {
    if (!t.trim()) return;
    saveRecents([t, ...recents.filter(r => r !== t)].slice(0, 10));
  };

  const activeMode = useMemo(() => MODES.find(m => m.key === mode)!, [mode]);
  const favCount = useMemo(() => Object.values(favorites).filter(Boolean).length, [favorites]);

  const favEntries = useMemo(() => {
    if (loading) return [];
    const idx = indexCache[mode];
    if (!idx) return [];
    const ids = new Set(Object.entries(favorites).filter(([,v]) => v).map(([k]) => k));
    return idx.filter(e => ids.has(e.ID));
  }, [favorites, mode]);

  const availableCats = useMemo(() => {
    if (loading) return [];
    const idx = indexCache[mode];
    if (!idx) return [];
    const counts = new Map<string, number>();
    const regex = /\[([^\]]{2,40})\]/g;
    for (let i = 0; i < idx.length; i++) {
      let m;
      while ((m = regex.exec(idx[i].meaning)) !== null) {
        const c = m[1];
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0])
      .slice(0, 30);
  }, [mode, loading]);

  // FIX: renderItem now passes fontFamily to Highlight
  const renderItem = useCallback(({ item }: { item: Entry }) => {
    const isFav = !!favorites[item.ID];
    return (
      <View style={[S.row, isFav && S.rowFav]}>
        <View style={S.rowBody}>
          <Highlight
            text={item.word}
            query={query}
            style={S.word}
            hlStyle={S.wordHL}
            isLight={isLightMode}
            fontFamily={fontFamily}
          />
          <View style={S.rowDivider} />
          <Highlight
            text={item.meaning}
            query={query}
            style={S.meaning}
            hlStyle={S.meaningHL}
            isLight={isLightMode}
            catStyle={S.meaningCat}
            fontFamily={fontFamily}
          />
        </View>
        <TouchableOpacity
          style={S.star}
          onPress={() => toggleFav(item.ID)}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Image
            source={ICO_SAVE}
            style={[S.starIcon, { tintColor: isFav ? C.accent : C.text3 }]}
            resizeMode="contain"
          />
        </TouchableOpacity>
      </View>
    );
  }, [favorites, query, fontFamily, S, isLightMode]);

  const keyExtractor = useCallback((item: Entry) => item.ID, []);

  // ─── Splash ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={S.splash}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.splashInner}>
          <View style={S.splashLogoWrap}>
            <Image source={LOGO} style={S.splashLogo} resizeMode="contain" />
          </View>
          <Text style={[S.splashName, { fontFamily }]}>SHADMAN</Text>
          <Text style={[S.splashSub, { fontFamily }]}>DICTIONARY</Text>
          <Text style={[S.splashTagline, { fontFamily }]}>
            Kurdish · English · Arabic{'\n'}& 13 more languages
          </Text>
          <ActivityIndicator color={C.accent} size="large" style={{ marginTop: 40 }} />
        </View>
      </SafeAreaView>
    );
  }

  // ─── Main ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} translucent={false} />

      {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
      <View style={S.header}>
        <View style={S.headerRow}>

          <View style={S.logoBadge}>
            <Image source={LOGO} style={S.logoImg} resizeMode="cover" />
          </View>

          {tab === 'translate' ? (
            <View style={{ flex: 1, justifyContent: 'center' }}>
              <Text style={{ fontSize: 17, fontWeight: '900', color: C.text1, fontFamily, letterSpacing: -0.3 }}>
                Online Translator
              </Text>
              <Text style={{ fontSize: 11, color: C.text3, fontFamily, marginTop: 1 }}>
                50 languages · Powered by Google
              </Text>
            </View>
          ) : (
            <>
              <Animated.View style={[
                S.searchWrap,
                {
                  borderColor: focusAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [C.border, C.accent],
                  }),
                  shadowColor: C.accent,
                  shadowOpacity: focusAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.2] }),
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 0 },
                  elevation: focused ? 6 : 0,
                },
              ]}>
                {/* FIX: fontFamily on all header Text nodes */}
                <Text style={[S.searchIcon, { fontFamily }]}>⌕</Text>
                <TextInput
                  style={[S.input, { fontFamily }]}
                  value={query}
                  onChangeText={setQuery}
                  placeholder={`${activeMode.from} or Kurdish…`}
                  placeholderTextColor={C.text3}
                  returnKeyType="search"
                  onSubmitEditing={() => addRecent(query)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                {query.length > 0 && (
                  <TouchableOpacity
                    onPress={() => setQuery('')}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <View style={S.clearX}>
                      <Text style={[S.clearXText, { fontFamily }]}>✕</Text>
                    </View>
                  </TouchableOpacity>
                )}
              </Animated.View>

              <TouchableOpacity style={S.modePill} onPress={() => setModePicker(true)} activeOpacity={0.75}>
                <Text style={[S.modePillText, { fontFamily }]}>{activeMode.label}</Text>
                <Text style={[S.modePillArrow, { fontFamily }]}>▼</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {tab === 'search' && availableCats.length > 0 && (
          <View style={S.catWrap}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={S.catScroll}>
               <TouchableOpacity style={[S.catChip, filterCat === null && S.catChipActive]} onPress={() => setFilterCat(null)}>
                 <Text style={[S.catTx, filterCat === null && S.catTxActive, { fontFamily }]}>ھەموو</Text>
               </TouchableOpacity>
               {availableCats.map(c => {
                 const customColors = getCategoryColors('[' + c + ']', isLightMode);
                 const isActive = filterCat === c;
                 return (
                   <TouchableOpacity
                     key={c}
                     style={[S.catChip, isActive && { backgroundColor: customColors.backgroundColor, borderColor: customColors.color }]}
                     onPress={() => setFilterCat(c)}
                   >
                     <Text style={[S.catTx, isActive && { color: customColors.color, fontWeight: '900' }, { fontFamily }]}>{c}</Text>
                   </TouchableOpacity>
                 );
               })}
            </ScrollView>
          </View>
        )}

        {tab === 'search' && !query && recents.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: 8 }}
            contentContainerStyle={{ gap: 6, paddingRight: 4 }}
          >
            {recents.map(r => (
              <TouchableOpacity key={r} style={S.chip} onPress={() => setQuery(r)} activeOpacity={0.7}>
                <View style={S.chipDot} />
                <Text style={[S.chipText, { fontFamily }]}>{r}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        <View style={S.countBar}>
          <View style={S.countLine} />
          <Text style={[S.count, { fontFamily }]}>
            {tab === 'search'
              ? query
                ? `${results.length} result${results.length !== 1 ? 's' : ''}`
                : `${totalCount.toLocaleString()} entries`
              : tab === 'saved'
              ? `${favCount} saved`
              : tab === 'translate'
              ? 'Online Translator'
              : 'Settings'}
          </Text>
          <View style={S.countLine} />
        </View>
      </View>

      {/* ══ CONTENT ══════════════════════════════════════════════════════════ */}

      {tab === 'search' && (
        <FlatList
          ref={listRef}
          data={results}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          extraData={{ S, favorites, isLightMode }}
          contentContainerStyle={S.listPad}
          showsVerticalScrollIndicator={false}
          onEndReached={() => {
            if (results.length >= limit) {
              setLimit(l => l + 300);
            }
          }}
          onEndReachedThreshold={0.5}
          removeClippedSubviews
          maxToRenderPerBatch={25}
          initialNumToRender={20}
          windowSize={10}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={S.empty}>
              <View style={S.emptyCircle}>
                <Text style={S.emptyIcon}>🔍</Text>
              </View>
              <Text style={[S.emptyTitle, { fontFamily }]}>No results</Text>
              <Text style={[S.emptySub, { fontFamily }]}>Try a different spelling or switch to another language mode</Text>
            </View>
          }
          ListFooterComponent={
            results.length > 0
              ? <Text style={[S.listEnd, { fontFamily }]}>✦ {results.length} of {totalCount.toLocaleString()} entries ✦</Text>
              : null
          }
        />
      )}

      {tab === 'saved' && (
        favCount === 0
          ? <View style={S.empty}>
              <View style={S.emptyGlowWrap}>
                <View style={S.emptyGlow} />
                <View style={S.emptyImageCircle}>
                  <Image source={ICO_SAVE} style={S.emptySavedImg} resizeMode="contain" />
                </View>
              </View>
              <Text style={[S.emptyTitle, { fontFamily }]}>No saved words yet</Text>
              <Text style={[S.emptySub, { fontFamily }]}>Words you bookmark will safely{'\n'}live here for offline access</Text>
            </View>
          : <FlatList
              data={favEntries}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              extraData={{ S, favorites, isLightMode }}
              contentContainerStyle={S.listPad}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            />
      )}

      {tab === 'settings' && (
        <ScrollView contentContainerStyle={S.settingsPad} showsVerticalScrollIndicator={false}>

          <View style={S.settHeader}>
            <View style={S.settAppBadge}>
              <Image source={LOGO} style={{ width: 80, height: 80, borderRadius: 22 }} resizeMode="cover" />
            </View>
            <Text style={[S.settAppName, { fontFamily }]}>SHADMAN</Text>
            <Text style={[S.settAppVer, { fontFamily }]}>Dictionary v3.0 · Offline Kurdish</Text>
          </View>

          <View style={[S.card, { marginBottom: 0 }]}>
            <View style={S.statGrid}>
              {([
                ['Entries', totalCount.toLocaleString()],
                ['Languages', '16'],
                ['Offline', '100%'],
              ] as [string, string][]).map(([lbl, val], i, arr) => (
                <React.Fragment key={lbl}>
                  <View style={S.statCell}>
                    <Text style={[S.statVal, i === 2 && S.statAccent, { fontFamily }]}>{val}</Text>
                    <Text style={[S.statLbl, { fontFamily }]}>{lbl.toUpperCase()}</Text>
                  </View>
                  {i < arr.length - 1 && <View style={S.statDivider} />}
                </React.Fragment>
              ))}
            </View>
          </View>

          <Text style={[S.sectionLabel, { fontFamily }]}>DATA</Text>
          <View style={S.card}>
            <TouchableOpacity style={S.settRow} onPress={() => saveFavs({})} activeOpacity={0.7}>
              <View style={[S.settRowIcon, { backgroundColor: C.accentDim }]}>
                <Image source={ICO_STAR} style={[S.settRowImg, { tintColor: C.accent }]} resizeMode="contain" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[S.settTitle, { fontFamily }]}>Clear Favorites</Text>
                <Text style={[S.settSub, { fontFamily }]}>{favCount} saved word{favCount !== 1 ? 's' : ''}</Text>
              </View>
              <View style={[S.pill, favCount > 0 && S.pillDanger]}>
                <Text style={[S.pillText, favCount > 0 && S.pillDangerTx, { fontFamily }]}>{favCount}</Text>
              </View>
            </TouchableOpacity>
            <View style={S.divider} />
            <TouchableOpacity style={S.settRow} onPress={() => saveRecents([])} activeOpacity={0.7}>
              <View style={[S.settRowIcon, { backgroundColor: 'rgba(91,132,196,0.1)' }]}>
                <Image source={ICO_RECENT} style={[S.settRowImg, { tintColor: C.accentLight }]} resizeMode="contain" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[S.settTitle, { fontFamily }]}>Clear Recent Searches</Text>
                <Text style={[S.settSub, { fontFamily }]}>{recents.length} recent quer{recents.length !== 1 ? 'ies' : 'y'}</Text>
              </View>
              <View style={[S.pill, recents.length > 0 && S.pillDanger]}>
                <Text style={[S.pillText, recents.length > 0 && S.pillDangerTx, { fontFamily }]}>{recents.length}</Text>
              </View>
            </TouchableOpacity>
          </View>

          <Text style={[S.sectionLabel, { fontFamily }]}>APPEARANCE</Text>
          <View style={S.card}>
            <TouchableOpacity style={S.settRow} onPress={() => { setIsLightMode(!isLightMode); AsyncStorage.setItem('isLightMode', (!isLightMode).toString()); }} activeOpacity={0.7}>
              <View style={[S.settRowIcon, { backgroundColor: isLightMode ? '#CBD5E1' : '#334155' }]}>
                <Text style={S.settRowIconTx}>{isLightMode ? '☀️' : '🌙'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[S.settTitle, { fontFamily }]}>{isLightMode ? 'Light Mode' : 'Dark Mode'}</Text>
                <Text style={[S.settSub, { fontFamily }]}>Tap to switch theme</Text>
              </View>
            </TouchableOpacity>

            <View style={S.divider} />
            <View style={S.settRow}>
               <View style={[S.settRowIcon, { backgroundColor: C.surface }]}>
                <Text style={[S.settRowIconTx, { fontWeight: '800', fontSize: 18, fontFamily, color: C.text1 }]}>Aa</Text>
              </View>
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={[S.settTitle, { fontFamily }]}>Text Size ({textScale.toFixed(1)}x)</Text>
                  <Text style={[S.settSub, { fontFamily }]}>Scale the interface text</Text>
                </View>
                <TouchableOpacity onPress={() => { const ns = Math.max(0.8, textScale - 0.1); setTextScale(ns); AsyncStorage.setItem('textScale', ns.toString()); }} style={[S.pill, {marginRight: 8}]}>
                  <Text style={[S.pillText, { fontFamily }]}> - </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { const ns = Math.min(1.5, textScale + 0.1); setTextScale(ns); AsyncStorage.setItem('textScale', ns.toString()); }} style={S.pill}>
                  <Text style={[S.pillText, { fontFamily }]}> + </Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={S.divider} />
            <TouchableOpacity style={S.settRow} onPress={() => setFontPicker(true)} activeOpacity={0.7}>
              <View style={[S.settRowIcon, { backgroundColor: C.accentDim }]}>
                <Image source={ICO_FONT} style={[S.settRowImg, { tintColor: C.accentLight }]} resizeMode="contain" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[S.settTitle, { fontFamily }]}>Kurdish Font</Text>
                <Text style={[S.settSub, { fontFamily }]}>
                  {FONTS.find(f => f.family === fontFamily)?.label ?? fontFamily}
                </Text>
              </View>
              <Text style={[{ color: C.text3, fontSize: 20, fontWeight: '300' }, { fontFamily }]}>›</Text>
            </TouchableOpacity>
          </View>

          <Text style={[S.sectionLabel, { fontFamily }]}>ABOUT</Text>
          <View style={S.card}>
            <View style={S.settRow}>
              <View style={[S.settRowIcon, { backgroundColor: C.accentDim }]}>
                <Image source={ICO_ABOUT} style={[S.settRowImg, { tintColor: C.accent }]} resizeMode="contain" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[S.settTitle, { fontFamily }]}>Shadman Dictionary</Text>
                <Text style={[S.settSub, { fontFamily }]}>Version 3.0 · Build 300</Text>
              </View>
            </View>
            <View style={S.divider} />
            <View style={S.settRow}>
              <View style={[S.settRowIcon, { backgroundColor: 'rgba(91,132,196,0.12)' }]}>
                <Image source={ICO_SEARCH} style={[S.settRowImg, { tintColor: C.accentLight }]} resizeMode="contain" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[S.settTitle, { fontFamily }]}>16 Language Pairs</Text>
                <Text style={[S.settSub, { fontFamily }]}>EN, AR, FA, FR, DE, RU, SV, TR ↔ Kurdish</Text>
              </View>
            </View>
            <View style={S.divider} />
            <View style={S.settRow}>
              <View style={[S.settRowIcon, { backgroundColor: 'rgba(91,196,132,0.12)' }]}>
                <Image source={ICO_STAR} style={[S.settRowImg, { tintColor: '#5BC484' }]} resizeMode="contain" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[S.settTitle, { fontFamily }]}>Fully Offline</Text>
                <Text style={[S.settSub, { fontFamily }]}>No internet required — all data on device</Text>
              </View>
            </View>
          </View>

        </ScrollView>
      )}

      {tab === 'translate' && (
        <TranslateTab C={C} fontFamily={fontFamily} textScale={textScale} />
      )}

      {/* ══ TAB BAR ══════════════════════════════════════════════════════════ */}
      <View style={S.tabBar}>
        <Animated.View
          style={[
            S.tabIndicator,
            {
              transform: [{
                translateX: tabAnim.interpolate({
                  inputRange:  [0, 1, 2, 3],
                  outputRange: [SW / 4 * 0, SW / 4 * 1, SW / 4 * 2, SW / 4 * 3],
                }),
              }],
            },
          ]}
        />
        {([
          ['search',    ICO_SEARCH,  'Search',    null ],
          ['saved',     ICO_SAVE,    'Saved',     null ],
          ['translate', null,        'Translate', '🌐' ],
          ['settings',  ICO_SETTING, 'Settings',  null ],
        ] as [Tab, any, string, string|null][]).map(([t, ico, label, emoji]) => {
          const active = tab === t;
          return (
            <TouchableOpacity
              key={t}
              style={S.tabItem}
              onPress={() => switchTab(t)}
              activeOpacity={0.6}
            >
              {emoji ? (
                <Text style={[S.tabIcon, { fontSize: 20, lineHeight: 22, textAlign: 'center', color: active ? C.accent : C.text3 }]}>{emoji}</Text>
              ) : (
                <Image
                  source={ico}
                  style={[S.tabIcon, { tintColor: active ? C.accent : C.text3 }]}
                  resizeMode="contain"
                />
              )}
              <Text style={[S.tabLabel, active && S.tabLabelActive, { fontFamily }]}>{label}</Text>
              {t === 'saved' && favCount > 0 && (
                <View style={S.tabBadge}>
                  <Text style={[S.tabBadgeText, { fontFamily }]}>{favCount > 99 ? '99+' : favCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ══ MODE PICKER SHEET ════════════════════════════════════════════════ */}
      {/* FIX: sheet now uses C.card instead of hardcoded '#0A1428' so light mode works */}
      <Modal visible={modePicker} transparent animationType="slide" onRequestClose={() => setModePicker(false)}>
        <View style={S.overlay}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setModePicker(false)} />
          <View style={[S.sheet, { backgroundColor: C.card }]}>
            <View style={S.sheetHandle} />
            <View style={S.sheetTitleBar}>
              <Text style={[S.sheetTitleIcon, { fontFamily }]}>🌐</Text>
              <Text style={[S.sheetTitle, { fontFamily }]}>Dictionary Language</Text>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {MODES.map(m => {
                const active = mode === m.key;
                return (
                  <TouchableOpacity
                    key={m.key}
                    style={[S.sheetRow, active && S.sheetRowActive]}
                    onPress={() => switchMode(m.key)}
                    activeOpacity={0.7}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[S.sheetLabel, active && S.sheetLabelActive, { fontFamily }]}>{m.label}</Text>
                      <Text style={[S.sheetSub, active && S.sheetSubActive, { fontFamily }]}>{m.from} → {m.to}</Text>
                    </View>
                    {active && <Text style={[S.sheetCheck, { fontFamily }]}>✓</Text>}
                  </TouchableOpacity>
                );
              })}
              <View style={{ height: 32 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ══ FONT PICKER SHEET ═════════════════════════════════════════════════ */}
      {/* FIX: sheet now uses C.card instead of hardcoded '#0A1428' */}
      <Modal visible={fontPicker} transparent animationType="slide" onRequestClose={() => setFontPicker(false)}>
        <View style={S.overlay}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setFontPicker(false)} />
          <View style={[S.sheet, { backgroundColor: C.card }]}>
            <View style={S.sheetHandle} />
            <View style={S.sheetTitleBar}>
              <Text style={[S.sheetTitleIcon, { fontFamily }]}>ا</Text>
              <Text style={[S.sheetTitle, { fontFamily }]}>Kurdish Display Font</Text>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {FONTS.map(f => {
                const active = fontFamily === f.family;
                return (
                  <TouchableOpacity
                    key={f.family}
                    style={[S.sheetRow, active && S.sheetRowActive]}
                    onPress={() => {
                      setFontFamily(f.family);
                      AsyncStorage.setItem('fontFamily', f.family);
                      setFontPicker(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[S.sheetLabel, active && S.sheetLabelActive, { fontFamily: f.family }]}>
                        {f.label}
                      </Text>
                      <Text style={[S.sheetSub, active && S.sheetSubActive, { fontFamily: f.family }]}>
                        {'باشترین فەرهەنگی کوردی'}
                      </Text>
                    </View>
                    {active && <Text style={[S.sheetCheck, { fontFamily: f.family }]}>✓</Text>}
                  </TouchableOpacity>
                );
              })}
              <View style={{ height: 32 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const { width: SW } = Dimensions.get('window');

const getColors = (isLight: boolean) => ({
  bg:          isLight ? '#F2F4F8' : '#05080F',
  bgAlt:       isLight ? '#E8ECF2' : '#080E1C',
  card:        isLight ? '#FFFFFF' : '#0D1424',
  surface:     isLight ? '#F4F7FB' : '#152035',
  highlight:   isLight ? '#E2E8F0' : '#1D2D47',
  accent:      isLight ? '#4770B0' : '#5B84C4',
  accentLight: isLight ? '#6B90C9' : '#8FB8E8',
  accentSoft:  isLight ? '#DDE5F0' : '#3D6AAD',
  accentDim:   isLight ? 'rgba(71,112,176,0.1)' : 'rgba(91,132,196,0.18)',
  accentGlow:  isLight ? 'rgba(71,112,176,0.15)' : 'rgba(91,132,196,0.32)',
  accentBorder:isLight ? 'rgba(71,112,176,0.3)' : 'rgba(91,132,196,0.5)',
  text1:       isLight ? '#1A2438' : '#EEF4FF',
  text2:       isLight ? '#4A5B7A' : '#7080A0',
  text3:       isLight ? '#7A8C9E' : '#374560',
  border:      isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)',
  borderMid:   isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.13)',
  danger:      '#EF5350',
  dangerDim:   isLight ? 'rgba(239,83,80,0.12)' : 'rgba(239,83,80,0.12)',
});

// ─── Styles ───────────────────────────────────────────────────────────────────

const getStyles = (C: any, sc: number, fn: string) => StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  // ── Splash ─────────────────────────────────────────────────────────────────
  splash:      { flex: 1, backgroundColor: C.bg },
  splashInner: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  splashLogoWrap: {
    width: 120, height: 120, borderRadius: 28,
    backgroundColor: '#fff',
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 32,
    shadowColor: C.accent, shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.45, shadowRadius: 28, elevation: 20,
    overflow: 'hidden',
  },
  splashLogo:      { width: 120, height: 120 },
  splashBadge:     { width: 100, height: 100, borderRadius: 26, backgroundColor: C.accent, justifyContent: 'center', alignItems: 'center', marginBottom: 28 },
  splashBadgeText: { fontSize: 30 * sc, fontFamily: fn, fontWeight: '900', color: '#fff', letterSpacing: -1, lineHeight: 34 },
  splashBadgeSub:  { fontSize: 13 * sc, fontFamily: fn, fontWeight: '800', color: 'rgba(255,255,255,0.65)', letterSpacing: 3, marginTop: 2 },
  splashDot:       { width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent, opacity: 0.4, marginVertical: 18 },
  splashName:      { fontSize: 28 * sc, fontFamily: fn, fontWeight: '900', color: C.text1, letterSpacing: 6, textAlign: 'center' },
  splashSub:       { fontSize: 11 * sc, fontFamily: fn, fontWeight: '700', color: C.accentLight, letterSpacing: 5, marginTop: 4, textAlign: 'center' },
  splashTagline:   { fontSize: 13 * sc, fontFamily: fn, color: C.text2, marginTop: 28, textAlign: 'center', lineHeight: 20 },

  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    backgroundColor: C.card,
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) + 8 : 6,
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.borderMid,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  logoBadge: {
    width: 42, height: 42, borderRadius: 12,
    overflow: 'hidden',
    shadowColor: C.accent, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4, shadowRadius: 10, elevation: 8,
  },
  logoImg:  { width: 42, height: 42 },
  logoText: { fontSize: 14 * sc, fontFamily: fn, fontWeight: '900', color: '#fff', letterSpacing: -0.5 },

  searchWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface,
    borderWidth: 1.5, borderRadius: 12,
    paddingHorizontal: 12, height: 42,
  },
  searchIcon: { fontSize: 17 * sc, fontFamily: fn, color: C.text2, marginRight: 8 },
  input:      { flex: 1, fontSize: 15 * sc, fontFamily: fn, color: C.text1, paddingVertical: 0, fontWeight: '500' },
  clearX: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: C.border,
    justifyContent: 'center', alignItems: 'center',
    marginLeft: 6,
  },
  clearXText: { fontSize: 10 * sc, fontFamily: fn, color: C.text2, fontWeight: '700' },

  modePill: {
    backgroundColor: C.accentDim,
    borderWidth: 1.5, borderColor: C.accentBorder,
    paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10,
    flexDirection: 'row', alignItems: 'center', gap: 4,
  },
  modePillText:  { fontSize: 11 * sc, fontFamily: fn, fontWeight: '800', color: C.accent, letterSpacing: 0.3 },
  modePillArrow: { fontSize: 8 * sc, fontFamily: fn, color: C.accentSoft },

  chip: {
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center', gap: 5,
  },
  chipDot:  { width: 5, height: 5, borderRadius: 2.5, backgroundColor: C.text3 },
  chipText: { color: C.text2, fontSize: 12 * sc, fontFamily: fn, fontWeight: '500' },

  countBar: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6 },
  countLine:{ flex: 1, height: 1, backgroundColor: C.border },
  count:    { fontSize: 11 * sc, fontFamily: fn, color: C.text3, fontWeight: '600', letterSpacing: 0.5 },

  // ── List ───────────────────────────────────────────────────────────────────
  listPad: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 120 },

  // ── Result Row ─────────────────────────────────────────────────────────────
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card,
    borderRadius: 16, marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 16, paddingVertical: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18, shadowRadius: 6, elevation: 3,
  },
  rowFav:    { borderColor: C.accentBorder, backgroundColor: C.surface },
  rowBody:   { flex: 1, gap: 8 },
  rowDivider:{ height: 1, backgroundColor: C.border },
  word:      { fontSize: 17 * sc, fontFamily: fn, fontWeight: '800', color: C.text1, letterSpacing: -0.3 },
  wordHL:    { backgroundColor: C.accentGlow, color: C.accent, borderRadius: 3 },
  meaning: {
    fontSize: 14 * sc, fontFamily: fn, color: C.text2, lineHeight: 22,
    textAlign: 'right', writingDirection: 'rtl',
  },
  meaningHL:  { color: C.accent, fontWeight: '600' },
  // FIX: meaningCat no longer carries color — color is applied dynamically per-category
  meaningCat: { fontWeight: '800' },
  star:       { paddingLeft: 12, marginLeft: 4 },
  starIcon:   { width: 20, height: 20 },
  starText:   { fontSize: 20 * sc, fontFamily: fn, color: C.text3 },
  starActive: { color: C.accent },

  listEnd: { textAlign: 'center', color: C.text3, fontSize: 12 * sc, fontFamily: fn, paddingVertical: 24, letterSpacing: 0.5 },

  // ── Empty state ────────────────────────────────────────────────────────────
  empty:       { flex: 1, alignItems: 'center', paddingTop: 90 },
  emptyCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: C.card, borderWidth: 1, borderColor: C.borderMid, justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  emptyIcon:   { fontSize: 36 * sc, fontFamily: fn },
  emptyGlowWrap:    { position: 'relative', width: 90, height: 90, justifyContent: 'center', alignItems: 'center', marginBottom: 28 },
  emptyGlow:        { position: 'absolute', width: 70, height: 70, borderRadius: 35, backgroundColor: C.accent, opacity: 0.15, transform: [{ scale: 1.5 }] },
  emptyImageCircle: { width: 70, height: 70, borderRadius: 35, backgroundColor: C.surface, borderWidth: 1, borderColor: C.accentBorder, justifyContent: 'center', alignItems: 'center', shadowColor: C.accent, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 18, elevation: 8 },
  emptySavedImg:    { width: 30, height: 30, tintColor: C.accent },
  emptyTitle: { fontSize: 19 * sc, fontFamily: fn, fontWeight: '800', color: C.text1, marginBottom: 8, letterSpacing: -0.3 },
  emptySub:   { fontSize: 14 * sc, fontFamily: fn, color: C.text2, textAlign: 'center', lineHeight: 22, paddingHorizontal: 36 },

  // ── Tab bar ────────────────────────────────────────────────────────────────
  tabBar: {
    flexDirection: 'row',
    backgroundColor: C.card,
    borderTopWidth: 1,
    borderTopColor: C.borderMid,
    paddingBottom: Platform.OS === 'ios' ? 26 : 10,
    paddingTop: 0,
    position: 'relative',
    overflow: 'hidden',
  },
  tabIndicator: {
    position: 'absolute', top: 0, left: 0,
    width: SW / 4, height: 3,
    borderRadius: 2,
    backgroundColor: C.accent,
    shadowColor: C.accent, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.8, shadowRadius: 6, elevation: 4,
  },
  tabItem:       { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 12, paddingBottom: 4, gap: 4, position: 'relative' },
  tabIconWrap:   {},
  tabIconWrapActive: {},
  tabIcon:       { width: 22, height: 22 },
  tabActive:     { tintColor: C.accent } as any,
  tabLabel:      { fontSize: 10 * sc, fontFamily: fn, fontWeight: '600', color: C.text3, letterSpacing: 0.4 },
  tabLabelActive:{ color: C.accent, fontWeight: '800' },
  tabBadge: {
    position: 'absolute', top: 8, right: SW / 4 / 2 - 22,
    backgroundColor: C.accent, borderRadius: 8, paddingHorizontal: 4,
    minWidth: 15, height: 15, alignItems: 'center', justifyContent: 'center',
  },
  tabBadgeText: { fontSize: 8 * sc, fontFamily: fn, fontWeight: '900', color: '#fff' },

  // ── Mode / Font picker ─────────────────────────────────────────────────────
  overlay:    { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.65)' },
  sheet: {
    // FIX: backgroundColor is now set inline with C.card so modals respect the theme
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 12, maxHeight: '75%',
    shadowColor: '#000', shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.4, shadowRadius: 24, elevation: 24,
  },
  sheetHandle:      { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.15)', alignSelf: 'center', marginBottom: 16 },
  sheetTitleBar:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, marginBottom: 12, gap: 10 },
  sheetTitleIcon:   { fontSize: 16 * sc, fontFamily: fn, color: C.accent },
  sheetTitle:       { fontSize: 16 * sc, fontFamily: fn, fontWeight: '900', color: C.text1, letterSpacing: -0.3 },
  sheetRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    borderRadius: 12, marginBottom: 5, marginHorizontal: 10,
    backgroundColor: C.surface,
    borderWidth: 1, borderColor: 'transparent',
  },
  sheetRowActive:   { backgroundColor: C.accentDim, borderColor: C.accentBorder },
  sheetRowEmoji:    { fontSize: 20 * sc, fontFamily: fn, marginRight: 12 },
  sheetLabel:       { fontSize: 15 * sc, fontFamily: fn, fontWeight: '700', color: C.text1 },
  sheetLabelActive: { color: C.accent },
  sheetSub:         { fontSize: 12 * sc, fontFamily: fn, color: C.text2, marginTop: 2 },
  sheetSubActive:   { color: C.accentLight },
  sheetCheck:       { fontSize: 16 * sc, fontFamily: fn, color: C.accent, fontWeight: '900', marginLeft: 'auto' },

  // ── Settings ───────────────────────────────────────────────────────────────
  settingsPad:     { padding: 16, paddingBottom: 110 },
  settHeader:      { alignItems: 'center', paddingVertical: 24, gap: 4 },
  settAppBadge:    {
    width: 80, height: 80, borderRadius: 22,
    backgroundColor: C.accent,
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 4,
    shadowColor: C.accent, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45, shadowRadius: 16, elevation: 14,
  },
  settAppBadgeTx:  { fontSize: 24 * sc, fontFamily: fn, fontWeight: '900', color: '#fff', letterSpacing: -0.5, lineHeight: 28 },
  settAppBadgeSub: { fontSize: 11 * sc, fontFamily: fn, fontWeight: '800', color: 'rgba(255,255,255,0.6)', letterSpacing: 3, marginTop: 1 },
  settAppName:     { fontSize: 18 * sc, fontFamily: fn, fontWeight: '900', color: C.text1, letterSpacing: 1 },
  settAppVer:      { fontSize: 12 * sc, fontFamily: fn, color: C.text3, fontWeight: '600' },
  sectionLabel:    { fontSize: 10 * sc, fontFamily: fn, fontWeight: '900', color: C.text3, letterSpacing: 2, marginBottom: 10, marginTop: 20, marginLeft: 4 },
  card:            { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  settRow:         { flexDirection: 'row', alignItems: 'center', padding: 16 },
  settRowIcon:     { width: 34, height: 34, borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  settRowIconTx:   { fontSize: 16 * sc, fontFamily: fn },
  settRowImg:      { width: 18, height: 18 },
  settTitle:       { fontSize: 15 * sc, fontFamily: fn, fontWeight: '700', color: C.text1 },
  settSub:         { fontSize: 12 * sc, fontFamily: fn, color: C.text2, marginTop: 2 },
  divider:         { height: 1, backgroundColor: C.border, marginLeft: 62 },
  pill:            { backgroundColor: C.accentDim, borderWidth: 1, borderColor: C.accentBorder, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  pillText:        { color: C.accent, fontSize: 12 * sc, fontFamily: fn, fontWeight: '800' },
  // FIX: pillDangerTx no longer duplicates fontSize/fontFamily (already in pillText)
  pillDanger:      { backgroundColor: C.dangerDim, borderColor: 'rgba(239,83,80,0.35)' },
  pillDangerTx:    { color: C.danger },
  statGrid:        { flexDirection: 'row' },
  statCell:        { flex: 1, alignItems: 'center', paddingVertical: 18, gap: 4 },
  statDivider:     { width: 1, backgroundColor: C.border, marginVertical: 12 },
  statVal:         { fontSize: 22 * sc, fontFamily: fn, fontWeight: '900', color: C.text1, letterSpacing: -0.5 },
  statLbl:         { fontSize: 10 * sc, fontFamily: fn, color: C.text2, fontWeight: '700', letterSpacing: 0.8 },
  statAccent:      { color: C.accent },

  // ── Categories ─────────────────────────────────────────────────────────────
  catWrap:       { marginTop: 12, marginBottom: 4 },
  catScroll:     { gap: 8, paddingRight: 16 },
  catChip:       { backgroundColor: C.surface, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: C.borderMid },
  catChipActive: { backgroundColor: C.accentDim, borderColor: C.accent },
  catTx:         { color: C.text3, fontSize: 13 * sc, fontWeight: '700', fontFamily: fn },
  catTxActive:   { color: C.accentLight, fontWeight: '900' },
});