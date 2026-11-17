import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], index: 0 }));
vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<typeof React>();
  return {
    ...original,
    useState: (initial: unknown) => {
      const index = hooks.index++;
      if (!(index in hooks.states))
        hooks.states[index] =
          typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [
        hooks.states[index],
        (value: unknown) => {
          hooks.states[index] =
            typeof value === 'function'
              ? (value as (previous: unknown) => unknown)(hooks.states[index])
              : value;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = hooks.index++;
      return (hooks.states[index] ??= { current: initial });
    },
  };
});
vi.mock('react-native', () => ({
  Button: 'Button',
  SafeAreaView: 'SafeAreaView',
  ScrollView: 'ScrollView',
  Text: 'Text',
}));
import { DiagnosticsScreen } from '../src/features/diagnostics/DiagnosticsScreen';

beforeEach(() => {
  hooks.states = [];
  hooks.index = 0;
});

describe('diagnostic screen', () => {
  it('disables the API button and prevents concurrent invocations before a rerender', async () => {
    let finish!: () => void;
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const props = {
      createNativeVaultDiagnostics: () => ({
        label: () => 'vault',
        next: async () => {},
        reopen: async () => {},
      }),
      runDiagnostics: async () => {},
      runVaultDiagnostics: async () => {},
      runApiDiagnostic: action,
    };
    const render = () => {
      hooks.index = 0;
      const screen = DiagnosticsScreen(props);
      const scroll = screen.props.children;
      return scroll.props.children.find(
        (child: { props?: { title?: string } }) => child?.props?.title === 'Tester connexion API',
      );
    };
    const button = render();
    button.props.onPress();
    button.props.onPress();
    expect(action).toHaveBeenCalledTimes(1);
    expect(render().props.disabled).toBe(true);
    finish();
    await vi.waitFor(() => expect(render().props.disabled).toBe(false));
  });
});
