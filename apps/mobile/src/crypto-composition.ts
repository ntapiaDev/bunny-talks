import { createArgon2Coordinator } from './argon2-coordinator';
import { createVaultNativeProvider } from './vault-native-provider';

// Module lifetime is independent of React mounts; callers cannot replace this provider.
const coordinator = createArgon2Coordinator();
export const applicationVaultArgon2Provider = Object.freeze(createVaultNativeProvider(coordinator));
