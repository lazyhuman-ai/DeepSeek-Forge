if (!Object.hasOwn) {
  Object.defineProperty(Object, "hasOwn", {
    value(object: object, key: PropertyKey): boolean {
      return Object.prototype.hasOwnProperty.call(object, key);
    },
    configurable: true,
    writable: true,
  });
}
