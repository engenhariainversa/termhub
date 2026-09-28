Pod::Spec.new do |s|
  s.name           = 'KeyCommands'
  s.version        = '0.0.0'
  s.summary        = 'Hardware-keyboard Enter / Shift+Enter for the termhub composer (TER-368 spike)'
  s.author         = 'termhub'
  s.homepage       = 'https://termhub.dev'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
