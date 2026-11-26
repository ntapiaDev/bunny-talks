Pod::Spec.new do |s|
  require 'json'
  mobile = File.expand_path('../../..', __dir__)
  bundle = JSON.parse(File.read(File.join(mobile, 'app.json'))).dig('expo', 'ios', 'bundleIdentifier')
  entry = JSON.parse(File.read(File.join(mobile, 'package.json')))['main']
  unless bundle == 'fr.bunnytalks.mobile.httpsqualification.urlsession' &&
         entry == 'qualification/standard-json-entry.tsx'
    raise 'URLSession qualification requires its dedicated app identity and entry point.'
  end

  s.name = 'ApplicationHttps'
  s.version = '0.1.0'
  s.summary = 'URLSession qualification transport for Bunny Talks'
  s.homepage = 'https://github.com/ntapiaDev/bunny-talks'
  s.license = { :type => 'Proprietary' }
  s.author = 'Bunny Talks'
  s.source = { :git => 'https://github.com/ntapiaDev/bunny-talks.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = 'ApplicationHttpsModule.swift', 'UrlSessionHttpsTransport.swift'
  s.pod_target_xcconfig = {
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) BUNNY_HTTPS_URLSESSION_QUALIFICATION'
  }
  s.dependency 'ExpoModulesCore'
end
