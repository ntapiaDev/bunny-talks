import { registerRootComponent, requireNativeModule } from 'expo';
import { Text } from 'react-native';

function IosLibcurlBuildEvidence() {
  const native = requireNativeModule<{ qualificationProfile(): string }>('ApplicationHttps');
  return <Text>{native.qualificationProfile()}</Text>;
}

registerRootComponent(IosLibcurlBuildEvidence);
