Pod::Spec.new do |s|
  s.name = 'EdoArchivePicker'
  s.version = '1.0.0'
  s.summary = 'Bounded local diary archive picker for Edo'
  s.description = 'Opens a user-selected archive and reads only within the restore size limit.'
  s.license = 'MPL-2.0'
  s.author = 'Lightwork Studio'
  s.homepage = 'https://github.com/lightwork-studio/edo'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/lightwork-studio/edo.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
