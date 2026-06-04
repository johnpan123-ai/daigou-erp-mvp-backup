// Test polyfill logic against a simulated read-only non-extensible globalThis.crypto object
console.log("Simulating browser HTTP context where window.crypto is read-only and non-extensible...");

const originalCryptoVal = {
  getRandomValues(buf) {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    return buf;
  }
};

// Freeze the object so it is non-extensible and read-only
Object.freeze(originalCryptoVal);

// Define globalThis.crypto as read-only and non-extensible
Object.defineProperty(globalThis, 'crypto', {
  value: originalCryptoVal,
  configurable: true, // configurable true so it can be redefined
  writable: false,
  enumerable: true
});

// Try to extend it directly to see it fail (as in the old code)
try {
  globalThis.crypto.randomUUID = function() {};
  console.log("Direct extension succeeded (unexpected!)");
} catch (e) {
  console.log("Direct extension failed as expected:", e.message);
}

// Now execute the polyfill logic
try {
  if (!globalThis.crypto.randomUUID) {
    try {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: function randomUUID() {
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });
        },
        writable: true,
        configurable: true,
        enumerable: false
      });
    } catch (err) {
      console.log("Object.defineProperty on crypto failed (read-only/non-extensible), applying fallback override...");
      const originalCrypto = globalThis.crypto;
      const newCrypto = Object.create(originalCrypto || {});
      newCrypto.randomUUID = function randomUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      };
      if (originalCrypto && typeof originalCrypto.getRandomValues === 'function') {
        Object.defineProperty(newCrypto, 'getRandomValues', {
          value: originalCrypto.getRandomValues.bind(originalCrypto),
          writable: true,
          configurable: true,
          enumerable: true
        });
      }
      Object.defineProperty(globalThis, 'crypto', {
        value: newCrypto,
        configurable: true,
        writable: true,
        enumerable: true
      });
    }
  }
  
  console.log("Polyfill applied successfully!");
  
  // Test UUID generation
  const uuid = crypto.randomUUID();
  console.log("Generated UUID:", uuid);
  const isValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
  console.log("Is valid UUID:", isValid);
  
  // Test getRandomValues preservation
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  console.log("getRandomValues still works:", buf);
  
} catch (e) {
  console.error("Polyfill threw an exception:", e);
}
