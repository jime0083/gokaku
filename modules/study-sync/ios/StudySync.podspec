Pod::Spec.new do |s|
  s.name           = 'StudySync'
  s.version        = '1.0.0'
  s.summary        = 'A sample project summary'
  s.description    = 'A sample project description'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '17.0'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # StudySyncConstants.swift・StudySyncCore.swift・StudyAttributes.swift はこのディレクトリの
  # シンボリックリンク(targets/_shared/ の実体を指す。5-3c-2)。CocoaPods の source_files は
  # podspec のディレクトリ外のパスを glob で拾えない(Pod::Sandbox::PathList がポッド自身の
  # ディレクトリ配下しかファイル一覧を作らないため、`../` で外に出る glob は常に0件になる。
  # cocoapods gem の path_list.rb の read_file_system で確認した)。
  # シンボリックリンクならポッド自身のディレクトリ内の1ファイルとして列挙されるため、
  # 以下の通常の glob だけで targets/_shared/ の実体を(複製せずに)取り込める
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
