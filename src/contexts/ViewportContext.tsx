import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';

type ViewMode = 'auto' | 'desktop' | 'mobile';

interface ViewportContextType {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
}

const ViewportContext = createContext<ViewportContextType | undefined>(undefined);

export function ViewportProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ViewMode>('desktop');
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  let isMobile = false;
  let isTablet = false;
  let isDesktop = false;

  if (mode === 'mobile') {
    isMobile = true;
  } else if (mode === 'desktop') {
    isDesktop = true;
  } else {
    // auto
    if (windowWidth < 768) {
      isMobile = true;
    } else if (windowWidth >= 768 && windowWidth < 1024) {
      isTablet = true;
    } else {
      isDesktop = true;
    }
  }

  return (
    <ViewportContext.Provider value={{ mode, setMode, isMobile, isTablet, isDesktop }}>
      {children}
    </ViewportContext.Provider>
  );
}

export function useViewport() {
  const context = useContext(ViewportContext);
  if (context === undefined) {
    throw new Error('useViewport must be used within a ViewportProvider');
  }
  return context;
}
