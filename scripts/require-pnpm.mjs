// krepis-kit depends on krepis through `workspace:^`. pnpm's pack/publish rewrites that to a real
// range; npm's does not, and would publish a manifest no registry install can satisfy.
if (!/^pnpm\//.test(process.env.npm_config_user_agent ?? '')) {
  console.error('Publish this package with `pnpm publish`: npm leaves `workspace:^` unconverted.');
  process.exit(1);
}
