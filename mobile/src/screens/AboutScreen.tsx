import React, { useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  Image,
  Modal,
  Text,
  TouchableOpacity,
} from 'react-native';
import { useNav } from '../state/NavContext';
import { openInBrowser } from '../system';
import { useTheme, metrics } from '../theme';
import TopBar, { BarTitle, BarButton } from '../ui/TopBar';
import Icon, { type IconName } from '../ui/Icon';

const LOGO = require('../assets/movira_logo.png');

export const APP_VERSION = '1.0.0';

/**
 * The links behind the "Official website" row. Each entry is presented as its
 * brand SYMBOL rather than a text label, so the `label` only exists to be
 * announced by a screen reader via `accessibilityLabel`.
 */
const LINKS: { key: string; icon: IconName; label: string; url: string }[] = [
  {
    key: 'linkedin',
    icon: 'linkedin',
    label: 'LinkedIn',
    url: 'https://www.linkedin.com/in/shaharukh-khan-5aa42b24b',
  },
  { key: 'github', icon: 'github', label: 'GitHub', url: 'https://github.com/Rkshah123' },
  {
    key: 'website',
    icon: 'globe',
    label: 'Official website',
    url: 'https://shaharukh-khan-premium-portfolio.vercel.app/',
  },
];

/** About page: large logo, name, platform line, version card and link rows. */
export default function AboutScreen() {
  const t = useTheme();
  const nav = useNav();
  const [openAuthors, setOpenAuthors] = useState(false);
  const [openLinks, setOpenLinks] = useState(false);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar
        left={<BarButton icon="back" label="Back" onPress={() => nav.pop()} />}
        center={<BarTitle text="About" />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.logoWrap}>
          <Image source={LOGO} style={styles.logo} resizeMode="contain" />
        </View>
        <Text style={[styles.name, { color: t.text }]}>Movira</Text>
        <Text style={[styles.platform, { color: t.dim }]}>Movira for Android</Text>

        <Text style={[styles.blurb, { color: t.dim }]}>
          Movira is a private media player. This is the Android edition. It plays video, audio stored
          on your device. Works fully offline. Never record what you watch.
        </Text>

        <View style={[styles.version, { backgroundColor: t.bg2 }]}>
          <Text style={[styles.versionNum, { color: t.accent }]}>{APP_VERSION}</Text>
          <Text style={[styles.versionDate, { color: t.dim }]}>2026-10-05</Text>
        </View>

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Official website, opens links"
          style={[styles.row, { backgroundColor: t.bg2, borderColor: t.border }]}
          onPress={() => setOpenLinks(true)}
        >
          <Icon name="globe" size={22} color={t.text} />
          <Text style={[styles.rowLabel, { color: t.text }]}>Official website</Text>
        </TouchableOpacity>

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Authors / Developer"
          style={[styles.row, { backgroundColor: t.bg2, borderColor: t.border }]}
          onPress={() => setOpenAuthors(true)}
        >
          <Icon name="person" size={22} color={t.text} />
          <Text style={[styles.rowLabel, { color: t.text }]}>Authors / Developer</Text>
        </TouchableOpacity>

        <View style={[styles.legal, { backgroundColor: t.bg2 }]}>
          <Text style={[styles.legalTitle, { color: t.text }]}>Copyright owned by Khan.</Text>
        </View>
      </ScrollView>

      <LinksDialog visible={openLinks} onClose={() => setOpenLinks(false)} />

      {openAuthors ? <AuthorsScreen onClose={() => setOpenAuthors(false)} /> : null}
    </View>
  );
}

/**
 * Small modal listing the three links as brand symbols. Tapping one opens it in
 * the browser and dismisses the dialog; tapping the backdrop or pressing back
 * just closes it.
 */
function LinksDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <TouchableOpacity
        style={[styles.backdrop, { backgroundColor: t.overlay }]}
        activeOpacity={1}
        onPress={onClose}
      >
        {/* Presses inside the card are swallowed, so they never reach the backdrop. */}
        <View style={[styles.linksCard, { backgroundColor: t.bg3, shadowColor: t.shadow }]}>
          <View style={styles.linksRow}>
            {LINKS.map((l) => (
              <TouchableOpacity
                key={l.key}
                accessibilityRole="link"
                accessibilityLabel={l.label}
                style={[styles.linkTile, { backgroundColor: t.bg2, borderColor: t.border }]}
                onPress={() => {
                  // Always the browser, never a dedicated app for the domain —
                  // otherwise GitHub quietly leaves Movira for its own app while
                  // the other two open in the browser.
                  void openInBrowser(l.url);
                  onClose();
                }}
              >
                <Icon name={l.icon} size={26} color={t.text} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

/** Authors and Developer page — a full page in the references, so it is one here too. */
export function AuthorsScreen({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const authors = ['Khan'];

  return (
    <View style={[styles.overlay, { backgroundColor: t.bg }]}>
      <TopBar
        left={<BarButton icon="close" label="Close" onPress={onClose} />}
        center={<BarTitle text="Authors and Developer" />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {authors.map((name) => (
          <View key={name} style={styles.authorRow}>
            <Icon name="person" size={22} color={t.text} />
            <Text style={[styles.authorName, { color: t.text }]}>{name}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 },
  content: { padding: metrics.screenPadding, paddingTop: 26, paddingBottom: 32 },
  logoWrap: { alignItems: 'center', marginBottom: 14 },
  logo: { width: 96, height: 96 },
  name: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  platform: { fontSize: 14, textAlign: 'center', marginTop: 6 },
  blurb: { fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 24, marginBottom: 22 },
  version: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 4, padding: 16, marginBottom: 14 },
  versionNum: { fontSize: 17 },
  versionDate: { fontSize: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    minHeight: 58,
    paddingHorizontal: 16,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
  },
  rowLabel: { fontSize: 15 },
  legal: { borderRadius: 4, padding: 16, marginTop: 6 },
  legalTitle: { fontSize: 15 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 52 },
  authorName: { fontSize: 16 },
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  linksCard: {
    borderRadius: 6,
    padding: 18,
    elevation: 12,
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  linksRow: { flexDirection: 'row', gap: 14 },
  /** Square tap target so each symbol is comfortable to hit on its own. */
  linkTile: {
    width: 62,
    height: 62,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});