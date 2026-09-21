import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyB5JsmSVkOtcjJIpdIUHGZsD2ymxpQHads',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'procurar-professores-5c04a.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'procurar-professores-5c04a',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'procurar-professores-5c04a.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '70860590637',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:70860590637:web:e98a46b30de796ff8e72a4',
}

const app = initializeApp(firebaseConfig)

export const db = getFirestore(app)
export const auth = getAuth(app)
