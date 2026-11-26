import { createArgon2Coordinator } from '../../../src/infrastructure/crypto/argon2-coordinator';
import { createVaultNativeProvider } from '../../../src/infrastructure/crypto/vault-native-provider';

// Module lifetime is independent of React mounts; callers cannot replace this provider.
const coordinator = createArgon2Coordinator();
export const applicationVaultArgon2Provider = Object.freeze(createVaultNativeProvider(coordinator));
