// The app's entry. The `crypto.getRandomValues` polyfill must run before any route module loads:
// expo-router evaluates `app/(tabs)/_layout.tsx` (and the stores it imports, which build the mock
// transport and draw random ids at load time) before the root `app/_layout.tsx`.
import 'react-native-get-random-values';
import 'expo-router/entry';
