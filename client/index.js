import { registerRootComponent } from 'expo';
import App from './App';
import { ThemeProvider } from './theme';

function Root() {
  return (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}

registerRootComponent(Root);
