declare module "busboy" {
  type BusboyFactory = (config: unknown) => unknown;
  const Busboy: BusboyFactory;
  export default Busboy;
}
