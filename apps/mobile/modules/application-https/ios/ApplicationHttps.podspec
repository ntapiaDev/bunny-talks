Pod::Spec.new do |s|
  s.name = 'ApplicationHttps'
  s.version = '0.1.0'
  s.summary = 'Bounded HTTPS transport for Bunny Talks'
  s.homepage = 'https://github.com/ntapiaDev/bunny-talks'
  s.license = { :type => 'Proprietary' }
  s.author = 'Bunny Talks'
  s.source = { :git => 'https://github.com/ntapiaDev/bunny-talks.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = '*.swift'
  if ENV['BUNNY_IOS_HTTPS_QUALIFICATION'] == '1'
    s.pod_target_xcconfig = { 'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) BUNNY_HTTPS_QUALIFICATION' }
  end
  s.dependency 'ExpoModulesCore'
end
