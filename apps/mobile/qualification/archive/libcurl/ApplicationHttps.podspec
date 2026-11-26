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
  s.source_files = 'ApplicationHttpsModule.swift', 'CurlHttpsTransport.swift', 'Native/BunnyHttpsNative.c'
  s.preserve_paths = 'Native/*', 'verify_xcframeworks.py', 'vendor/xcframeworks.zip', 'vendor/package/**/*'

  qualification = ENV['BUNNY_IOS_HTTPS_QUALIFICATION'] == '1'
  if qualification
    require 'json'
    mobile = File.expand_path('../../..', __dir__)
    begin
      bundle = JSON.parse(File.read(File.join(mobile, 'app.json'))).dig('expo', 'ios', 'bundleIdentifier')
      entry = JSON.parse(File.read(File.join(mobile, 'package.json')))['main']
    rescue SystemCallError, JSON::ParserError, TypeError
      raise 'ApplicationHttps could not read qualification app configuration.', cause: nil
    end
    qualification_entries = {
      'fr.bunnytalks.mobile.httpsqualification' => 'qualification/ios-libcurl-build-entry.tsx',
      'fr.bunnytalks.mobile.httpsqualification.libcurl' => 'qualification/ios-libcurl-runtime-entry.tsx'
    }
    unless qualification_entries.key?(bundle) && qualification_entries[bundle] == entry
      raise 'ApplicationHttps qualification flags require a dedicated qualification app identity and entry point.'
    end
  end

  verifier = File.join(__dir__, 'verify_xcframeworks.py')
  archive = File.join(__dir__, 'vendor', 'xcframeworks.zip')
  package = File.join(__dir__, 'vendor', 'package')
  unless system('python3', '-I', verifier, 'stage', archive, package)
    raise 'ApplicationHttps requires the approved ZIP. Run verify_xcframeworks.py install with the approved ZIP path.'
  end

  s.vendored_frameworks = 'vendor/package/libcurl.xcframework', 'vendor/package/libopenssl.xcframework'
  s.frameworks = 'Security', 'CoreFoundation', 'CoreServices'
  s.libraries = 'z'
  s.resource_bundles = {
    'ApplicationHttpsLicenses' => ['vendor/package/curl-COPYING', 'vendor/package/openssl-LICENSE.txt']
  }
  headers_root = '$(PODS_TARGET_SRCROOT)/vendor/package/libcurl.xcframework'
  settings = {
    'SWIFT_INCLUDE_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/Native"',
    'HEADER_SEARCH_PATHS[sdk=iphoneos*]' => "$(inherited) \"#{headers_root}/ios-arm64/Headers\"",
    'HEADER_SEARCH_PATHS[sdk=iphonesimulator*]' => "$(inherited) \"#{headers_root}/ios-arm64-simulator/Headers\"",
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => '$(inherited) x86_64',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) CURL_STATICLIB=1'
  }
  if qualification
    settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) BUNNY_HTTPS_QUALIFICATION'
    settings['GCC_PREPROCESSOR_DEFINITIONS'] += ' BUNNY_HTTPS_QUALIFICATION=1'
  end
  s.pod_target_xcconfig = settings
  s.user_target_xcconfig = { 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => '$(inherited) x86_64' }
  s.script_phase = {
    :name => 'Verify pinned HTTPS libraries',
    :execution_position => :before_compile,
    :input_files => [
      '$(PODS_TARGET_SRCROOT)/verify_xcframeworks.py',
      '$(PODS_TARGET_SRCROOT)/vendor/xcframeworks.zip',
      '$(PODS_TARGET_SRCROOT)/vendor/package'
    ],
    :script => 'python3 -I "$PODS_TARGET_SRCROOT/verify_xcframeworks.py" verify "$PODS_TARGET_SRCROOT/vendor/xcframeworks.zip" "$PODS_TARGET_SRCROOT/vendor/package"'
  }
  s.dependency 'ExpoModulesCore'
end
