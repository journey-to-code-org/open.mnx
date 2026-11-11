# frozen_string_literal: true

require_relative "lib/zubra"

Gem::Specification.new do |spec|
  spec.name = "zubra"
  spec.version = Zubra::VERSION
  spec.summary = "Render Zubra web components from Ruby and Rails: the zubra compiler as a long-lived process"
  spec.description = "Server-renders Zubra (.zb) components through `zubra serve`, with Rails view helpers, a Rack middleware and a module endpoint. No Node.js on the server."
  spec.authors = ["Mikey Nichols"]
  spec.license = "ISC"
  spec.homepage = "https://github.com/journey-to-code-org/zubra/tree/main/clients/ruby"
  spec.required_ruby_version = ">= 3.1"
  spec.files = Dir["lib/**/*.rb", "README.md"]
  spec.require_paths = ["lib"]
  spec.metadata = { "source_code_uri" => "https://github.com/journey-to-code-org/zubra" }
end
