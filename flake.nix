{
  description = "AI-powered LSP server with flexible model provider support";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs, ... }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      lib = nixpkgs.lib;
      forEachSystem = lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
      version = packageJson.version;
    in
    {
      # Development shell
      devShells = forEachSystem (system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              nodePackages.typescript-language-server
            ];
            
            shellHook = ''
              echo "ai-lsp development environment"
              echo ""
              echo "Available commands:"
              echo "  bun install       - Install dependencies"
              echo "  bun start         - Start the LSP server"
              echo "  bun test          - Run all tests"
              echo "  bunx tsc --noEmit - Type check"
              echo "  bun run lint      - Lint code"
              echo ""
              echo "Flake apps (use 'nix run .#<app>'):"
              echo "  test              - Run all tests"
              echo "  test-unit         - Run unit tests only"
              echo "  test-e2e          - Run e2e tests"
              echo "  test-benchmark    - Run benchmark tests"
              echo "  lint              - Run linter"
              echo "  lint-fix          - Run linter with auto-fix"
              echo "  typecheck         - Type check with tsc"
              echo "  benchmark         - Run next-edit benchmark"
              echo "  benchmark-inline  - Run inline completion benchmark"
            '';
          };
        }
      );

      # Package definition
      packages = forEachSystem (system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.stdenv.mkDerivation {
            pname = "ai-lsp";
            inherit version;
            
            src = ./.;
            
            buildInputs = [ pkgs.bun ];
            
            buildPhase = ''
              export HOME=$TMPDIR
              bun install --frozen-lockfile
              bun run build:bundle
            '';
            
            installPhase = ''
              mkdir -p $out/bin
              cp dist/cli.js $out/bin/ai-lsp
              chmod +x $out/bin/ai-lsp
            '';
            
            meta = with lib; {
              description = "AI-powered LSP server with flexible model provider support";
              license = licenses.asl20;
              platforms = systems;
              maintainers = [ ];
            };
          };
        }
      );

      # Applications
      apps = forEachSystem (system:
        let
          pkgs = pkgsFor system;
        in
        {
          # Default app runs the LSP server
          default = {
            type = "app";
            program = "${self.packages.${system}.default}/bin/ai-lsp";
          };

          # Run all tests
          test = {
            type = "app";
            program = toString (pkgs.writeShellScript "test" ''
              export PATH="${pkgs.bun}/bin:$PATH"
              exec ${pkgs.bun}/bin/bun test "$@"
            '');
          };

          # Run unit tests only
          test-unit = {
            type = "app";
            program = toString (pkgs.writeShellScript "test-unit" ''
              export PATH="${pkgs.bun}/bin:$PATH"
              exec ${pkgs.bun}/bin/bun test tests/*.test.ts "$@"
            '');
          };

          # Run e2e tests
          test-e2e = {
            type = "app";
            program = toString (pkgs.writeShellScript "test-e2e" ''
              export PATH="${pkgs.bun}/bin:$PATH"
              exec ${pkgs.bun}/bin/bun test tests/e2e/**/*.test.ts "$@"
            '');
          };

          # Run benchmark tests
          test-benchmark = {
            type = "app";
            program = toString (pkgs.writeShellScript "test-benchmark" ''
              export PATH="${pkgs.bun}/bin:$PATH"
              exec ${pkgs.bun}/bin/bun test tests/benchmark-*.test.ts "$@"
            '');
          };

          # Run linter
          lint = {
            type = "app";
            program = toString (pkgs.writeShellScript "lint" ''
              export PATH="${pkgs.bun}/bin:$PATH"
              exec ${pkgs.bun}/bin/bun run lint "$@"
            '');
          };

          # Run linter with auto-fix
          lint-fix = {
            type = "app";
            program = toString (pkgs.writeShellScript "lint-fix" ''
              export PATH="${pkgs.bun}/bin:$PATH"
              exec ${pkgs.bun}/bin/bun run lint:fix "$@"
            '');
          };

          # Type check
          typecheck = {
            type = "app";
            program = toString (pkgs.writeShellScript "typecheck" ''
              export PATH="${pkgs.bun}/bin:$PATH"
              exec ${pkgs.bun}/bin/bunx tsc --noEmit "$@"
            '');
          };

          # Run inline completion benchmark
          benchmark-inline = {
            type = "app";
            program = toString (pkgs.writeShellScript "benchmark-inline" ''
              export PATH="${pkgs.bun}/bin:$PATH"
              exec ${pkgs.bun}/bin/bun run scripts/inline-benchmark.ts "$@"
            '');
          };

          # Run next-edit benchmark
          benchmark = {
            type = "app";
            program = toString (pkgs.writeShellScript "benchmark" ''
              export PATH="${pkgs.bun}/bin:$PATH"
              exec ${pkgs.bun}/bin/bun run scripts/benchmark.ts "$@"
            '');
          };
        }
      );
    };
}
