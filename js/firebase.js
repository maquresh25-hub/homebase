
const FIREBASE_VERSION = "13.2.0";
const FB = "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/";
const firebaseConfig = {
  apiKey: "AIzaSyAvqZ0tXJbcwSdEhqeaRjYDFG-imnw753I",
  authDomain: "homebase-daa1f.firebaseapp.com",
  projectId: "homebase-daa1f",
  storageBucket: "homebase-daa1f.firebasestorage.app",
  messagingSenderId: "109987977650",
  appId: "1:109987977650:web:21e09eeaa5e1f77710ecab",
};
let fb = null;        // loaded Firebase functions + instances

// ================================================================ FIREBASE
async function loadFirebase() {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(FB + "firebase-app.js"),
    import(FB + "firebase-auth.js"),
    import(FB + "firebase-firestore.js"),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  // initializeAuth (not getAuth) skips the hidden sign-in iframe that hangs
  // in iPhone home-screen apps. Email + password sign-in doesn't need it.
  const auth = authMod.initializeAuth(app, {
    persistence: [authMod.indexedDBLocalPersistence, authMod.browserLocalPersistence],
  });
  let db;
  try {
    // Keeps a copy on the device: the app opens instantly and works offline.
    db = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn("Offline copy unavailable, using online only:", e);
    db = fsMod.getFirestore(app);
  }
  fb = {
    auth, db,
    onAuthStateChanged: authMod.onAuthStateChanged,
    signInWithEmailAndPassword: authMod.signInWithEmailAndPassword,
    sendPasswordResetEmail: authMod.sendPasswordResetEmail,
    signOut: authMod.signOut,
    collection: fsMod.collection,
    doc: fsMod.doc,
    setDoc: fsMod.setDoc,
    deleteField: fsMod.deleteField,
    getDoc: fsMod.getDoc,
    updateDoc: fsMod.updateDoc,
    onSnapshot: fsMod.onSnapshot,
    query: fsMod.query,
    where: fsMod.where,
  };
}

export { fb, loadFirebase };
