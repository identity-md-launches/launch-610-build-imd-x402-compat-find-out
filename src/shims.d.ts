declare module '../vendor/ethers.cjs' {
  const ethers: any;
  export default ethers;
}
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number;
};
