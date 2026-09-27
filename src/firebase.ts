import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyCscvBCfXJJhOd1B0ySY1g2hbwjNkWUdvo',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'd-tech-8555e.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'd-tech-8555e',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'd-tech-8555e.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '271628082137',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:271628082137:web:fb9d0c86a4178f8f4357c8',
}

const app = initializeApp(firebaseConfig)

export const db = getFirestore(app)
export const auth = getAuth(app)
