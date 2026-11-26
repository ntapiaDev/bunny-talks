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
  s.source_files = 'ApplicationHttpsModule.swift', 'UrlSessionHttpsTransport.swift'
  s.frameworks = 'Foundation'

  require 'json'
  mobile = File.expand_path('../../..', __dir__)
  bundle = JSON.parse(File.read(File.join(mobile, 'app.json'))).dig('expo', 'ios', 'bundleIdentifier')
  entry = JSON.parse(File.read(File.join(mobile, 'package.json')))['main']
  qualification_bundle = bundle == 'fr.bunnytalks.mobile.httpsqualification.urlsession'
  qualification_entry = entry == 'qualification/standard-json-entry.tsx'
  if qualification_bundle != qualification_entry
    raise 'URLSession qualification requires its dedicated app identity and entry point.'
  end
  if qualification_bundle
    s.pod_target_xcconfig = {
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) BUNNY_HTTPS_URLSESSION_QUALIFICATION'
    }
  end
  s.dependency 'ExpoModulesCore'
end
