import React from 'react';
import { View, Text, TouchableOpacity, StatusBar, Image, StyleSheet } from 'react-native';
import { logToAndroid } from './system';
import { useTheme } from './theme';

interface State {
  hasError: boolean;
  message: string;
  stack?: string;
}

/**
 * Top-level crash guard: React render exceptions anywhere in the app are caught
 * here and shown as a recovery screen instead of tearing the process down
 * (the default release behaviour for an uncaught render error is an instant
 * close — the "launches briefly then crashes" symptom).
 */
export default class CrashGuard extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: unknown): State {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : String(err ?? 'Unknown error'),
    };
  }

  componentDidCatch(err: unknown, info: { componentStack?: string }) {
    const stack = info?.componentStack ?? '';
    logToAndroid('CRASH: ' + (err instanceof Error ? err.message : String(err)));
    logToAndroid('STACK: ' + stack.split('\n').slice(0, 12).join(' | '));
    this.setState({ stack: stack.split('\n').slice(0, 5).join('\n') });
    console.warn('Movira: caught UI error:', err);
  }

  render() {
    if (this.state.hasError) {
      return (
        <CrashScreen
          message={this.state.message}
          stack={this.state.stack}
          onReset={() => this.setState({ hasError: false, message: '' })}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * The recovery screen reads the active theme like every other screen — a class
 * component cannot call hooks, so the themed part is its own function
 * component rendered from the boundary (which lives inside ThemeProvider).
 */
function CrashScreen({
  message,
  stack,
  onReset,
}: {
  message: string;
  stack?: string;
  onReset: () => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.wrap, { backgroundColor: t.bg }]}>
      <StatusBar barStyle={t.dark ? 'light-content' : 'dark-content'} backgroundColor={t.bg} />
      <Image source={require('./assets/movira_logo.png')} style={styles.logo} resizeMode="contain" />
      <Text style={[styles.title, { color: t.text }]}>Movira hit a problem</Text>
      <Text style={[styles.msg, { color: t.dim }]} numberOfLines={4}>
        {message}
      </Text>
      <Text style={[styles.stack, { color: t.dim }]} numberOfLines={8}>
        {stack ?? ''}
      </Text>
      <TouchableOpacity style={[styles.btn, { backgroundColor: t.accent }]} onPress={onReset}>
        <Text style={[styles.btnText, { color: t.bg }]}>Reload Movira</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 28,
  },
  logo: { width: 120, height: 120, opacity: 0.9, marginBottom: 6 },
  title: { fontSize: 18, fontWeight: '700' },
  msg: { fontSize: 12, textAlign: 'center' },
  stack: { fontSize: 10, textAlign: 'center' },
  btn: {
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
    marginTop: 8,
  },
  btnText: { fontWeight: '700' },
});
