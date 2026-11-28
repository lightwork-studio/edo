require "xcodeproj"

project_path = ARGV.fetch(0)
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == "Edo" }
abort "Missing Edo app target" unless app

test = project.new_target(:ui_test_bundle, "OfflineSmokeUITests", :ios, app.deployment_target)
test.add_dependency(app)
test.source_build_phase.add_file_reference(project.main_group.new_file("OfflineSmokeUITests.swift"))
test.build_configurations.each do |configuration|
  configuration.build_settings.merge!(
    "GENERATE_INFOPLIST_FILE" => "YES",
    "PRODUCT_BUNDLE_IDENTIFIER" => "studio.lightwork.edo.OfflineSmokeUITests",
    "PRODUCT_NAME" => test.name,
    "SWIFT_VERSION" => "5.0",
    "TEST_TARGET_NAME" => app.name
  )
end
attributes = project.root_object.attributes["TargetAttributes"] ||= {}
attributes[test.uuid] = { "TestTargetID" => app.uuid }
project.save

scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(app, test, launch_target: true)
scheme.test_action.build_configuration = "Release"
scheme.save_as(project_path, "OfflineSmoke")
