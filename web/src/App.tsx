import './App.css'
import { AuthProvider, useAuth } from './context/AuthContext.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { Login } from './components/Login.tsx'
import { Layout } from './components/Layout.tsx'

function AppContent() {
  const { isAuthenticated, logout } = useAuth();
  return (
    <ErrorBoundary onLogout={isAuthenticated ? logout : undefined}>
      {isAuthenticated ? <Layout /> : <Login />}
    </ErrorBoundary>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App
