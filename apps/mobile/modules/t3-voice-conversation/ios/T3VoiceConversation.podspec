Pod::Spec.new do |s|
  s.name = 'T3VoiceConversation'
  s.version = '1.0.0'
  s.summary = 'Bounded PCM conversation audio for T3 Code.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation', 'UIKit'
end
