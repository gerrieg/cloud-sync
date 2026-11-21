import { useCallback, useEffect, useState } from 'react';
import { listDeleteApprovals, type DeleteApprovalDto } from './delete-approvals-api.js';

/** Loads the Profile's pending Delete Guard batches; call `refresh` after anything that may add or resolve one. */
export function useDeleteApprovals(profileId: string) {
  const [approvals, setApprovals] = useState<DeleteApprovalDto[]>([]);

  const refresh = useCallback(async () => {
    try {
      setApprovals(await listDeleteApprovals(profileId));
    } catch {
      // The banner is a safety net on top of the sync UI; a failed refresh must not hide the rest
    }
  }, [profileId]);

  useEffect(() => {
    let active = true;
    setApprovals([]);
    listDeleteApprovals(profileId)
      .then((loaded) => active && setApprovals(loaded))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [profileId]);

  return { approvals, refresh };
}
