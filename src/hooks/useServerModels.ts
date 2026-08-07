import { useState, useEffect } from 'react';
import APP_CONFIG from '@/config';

interface ServerModel {
  id: string;
  name: string;
  provider: string;
}

interface ServerStatus {
  fallbackEnabled: boolean;
  geminiEnabled: boolean;
  groqEnabled: boolean;
  models: ServerModel[];
  defaultModel: string;
}

export function useServerModels() {
  const [serverModels, setServerModels] = useState<ServerModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [serverAvailable, setServerAvailable] = useState(false);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const response = await fetch(`${APP_CONFIG.API_URL}/api/translate/status`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
        
        if (response.ok) {
          const data: ServerStatus = await response.json();
          if (data.fallbackEnabled && data.models.length > 0) {
            setServerModels(data.models);
            setDefaultModel(data.defaultModel);
            setServerAvailable(true);
            console.log('[ServerModels] Available:', data.models.length, 'Default:', data.defaultModel);
          }
        }
      } catch (err) {
        // Server not available - ignore
        console.log('[ServerModels] Server not available');
      } finally {
        setIsLoading(false);
      }
    }

    fetchStatus();
  }, []);

  return { serverModels, defaultModel, serverAvailable, isLoading };
}
