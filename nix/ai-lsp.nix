{ lib, stdenvNoCC, bun }:
args:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "ai-lsp";
  version = args.version;

  src = args.src;

  node_modules = args.mkNodeModules {
    version = finalAttrs.version;
    src = finalAttrs.src;
  };

  nativeBuildInputs = [ bun ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

    # Copy pre-built node_modules
    cp -r ${finalAttrs.node_modules}/node_modules .
    chmod -R u+w ./node_modules

    # Build the bundle
    bun run build:bundle

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    cp dist/cli.js $out/bin/ai-lsp
    chmod +x $out/bin/ai-lsp

    runHook postInstall
  '';

  # Skip fixup phase to preserve Bun's node_modules structure and binary formats
  dontFixup = true;

  meta = with lib; {
    description =
      "AI-powered LSP server with flexible model provider support";
    license = licenses.asl20;
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
      "aarch64-darwin"
      "x86_64-darwin"
    ];
    mainProgram = "ai-lsp";
  };
})
