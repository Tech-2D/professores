import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyB_MxCB32Umi613ELc5QGsURRPRfZ-sZVM',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'd-tech-56a76.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'd-tech-56a76',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'd-tech-56a76.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '243849051009',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:243849051009:web:9d52edb8e1329bf3c9c680',
}

const app = initializeApp(firebaseConfig)

export const db = getFirestore(app)
export const auth = getAuth(app)
