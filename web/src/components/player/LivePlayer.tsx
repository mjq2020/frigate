import WebRtcPlayer from "./WebRTCPlayer";
import { CameraConfig } from "@/types/frigateConfig";
import AutoUpdatingCameraImage from "../camera/AutoUpdatingCameraImage";
import ActivityIndicator from "../indicators/activity-indicator";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MSEPlayer from "./MsePlayer";
import JSMpegPlayer from "./JSMpegPlayer";
import { MdCircle } from "react-icons/md";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useCameraActivity } from "@/hooks/use-camera-activity";
import {
  LivePlayerError,
  LivePlayerMode,
  PlayerStatsType,
  VideoResolutionType,
} from "@/types/live";
import { getIconForLabel } from "@/utils/iconUtil";
import Chip from "../indicators/Chip";
import { capitalizeFirstLetter } from "@/utils/stringUtil";
import { cn } from "@/lib/utils";
import { TbExclamationCircle } from "react-icons/tb";
import { TooltipPortal } from "@radix-ui/react-tooltip";
import { baseUrl } from "@/api/baseUrl";
import { PlayerStats } from "./PlayerStats";

type LivePlayerProps = {
  cameraRef?: (ref: HTMLDivElement | null) => void;
  containerRef?: React.MutableRefObject<HTMLDivElement | null>;
  className?: string;
  cameraConfig: CameraConfig;
  streamName: string;
  preferredLiveMode: LivePlayerMode;
  showStillWithoutActivity?: boolean;
  useWebGL: boolean;
  windowVisible?: boolean;
  playAudio?: boolean;
  volume?: number;
  playInBackground: boolean;
  micEnabled?: boolean; // only webrtc supports mic
  iOSCompatFullScreen?: boolean;
  pip?: boolean;
  autoLive?: boolean;
  showStats?: boolean;
  onClick?: () => void;
  setFullResolution?: React.Dispatch<React.SetStateAction<VideoResolutionType>>;
  onError?: (error: LivePlayerError) => void;
  onResetLiveMode?: () => void;
};

type DetectionResult = {
  topic: string;
  payload: {
    id: string;
    fps?: number;
    label: string;
    score: number;
    box: [number, number, number, number]; // [x1, y1, x2, y2]
    area: number;
    current_zones: string[];
  }[];
};

export default function LivePlayer({
  cameraRef = undefined,
  containerRef,
  className,
  cameraConfig,
  streamName,
  preferredLiveMode,
  showStillWithoutActivity = true,
  useWebGL = false,
  windowVisible = true,
  playAudio = false,
  volume,
  playInBackground = false,
  micEnabled = false,
  iOSCompatFullScreen = false,
  pip,
  autoLive = true,
  showStats = false,
  onClick,
  setFullResolution,
  onError,
  onResetLiveMode,
}: LivePlayerProps) {
  const internalContainerRef = useRef<HTMLDivElement | null>(null);

  // stats

  const [stats, setStats] = useState<PlayerStatsType>({
    streamType: "-",
    bandwidth: 0, // in kbps
    latency: undefined, // in seconds
    totalFrames: 0,
    droppedFrames: undefined,
    decodedFrames: 0,
    droppedFrameRate: 0, // percentage
  });

  // camera activity

  const { activeMotion, activeTracking, objects, offline } =
    useCameraActivity(cameraConfig);

  const cameraActive = useMemo(
    () =>
      !showStillWithoutActivity ||
      (windowVisible && (activeMotion || activeTracking)),
    [activeMotion, activeTracking, showStillWithoutActivity, windowVisible],
  );

  // camera live state

  const [liveReady, setLiveReady] = useState(false);

  const liveReadyRef = useRef(liveReady);
  const cameraActiveRef = useRef(cameraActive);

  useEffect(() => {
    liveReadyRef.current = liveReady;
    cameraActiveRef.current = cameraActive;
  }, [liveReady, cameraActive]);

  useEffect(() => {
    if (!autoLive || !liveReady) {
      return;
    }

    if (!cameraActive) {
      const timer = setTimeout(() => {
        if (liveReadyRef.current && !cameraActiveRef.current) {
          setLiveReady(false);
          onResetLiveMode?.();
        }
      }, 500);

      return () => {
        clearTimeout(timer);
      };
    }
    // live mode won't change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLive, cameraActive, liveReady]);

  // camera still state

  const stillReloadInterval = useMemo(() => {
    if (!windowVisible || offline || !showStillWithoutActivity) {
      return -1; // no reason to update the image when the window is not visible
    }

    if (liveReady && !cameraActive) {
      return 300;
    }

    if (liveReady) {
      return 60000;
    }

    if (activeMotion || activeTracking) {
      if (autoLive) {
        return 200;
      } else {
        return 59000;
      }
    }

    return 30000;
  }, [
    autoLive,
    showStillWithoutActivity,
    liveReady,
    activeMotion,
    activeTracking,
    offline,
    windowVisible,
    cameraActive,
  ]);

  useEffect(() => {
    setLiveReady(false);
  }, [preferredLiveMode]);

  const [key, setKey] = useState(0);

  const resetPlayer = () => {
    setLiveReady(false);
    setKey((prevKey) => prevKey + 1);
  };

  useEffect(() => {
    if (streamName) {
      resetPlayer();
    }
  }, [streamName]);

  useEffect(() => {
    if (showStillWithoutActivity && !autoLive) {
      setLiveReady(false);
    }
  }, [showStillWithoutActivity, autoLive]);

  const playerIsPlaying = useCallback(() => {
    setLiveReady(true);
  }, []);

  // Add a canvas reference
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const [detectionData, setDetectionData] = useState<DetectionResult | null>(null);
  
  useEffect(() => {
    if (!cameraConfig) return;
    
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws").replace("5000", "5003")}ws`);
    wsRef.current = ws;
    
    ws.onopen = () => {
      console.log('WebSocket Connection established');
    };
    
    // Processing of received messages
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as DetectionResult;
        
        // Check if it is data from the current camera
        if (data.topic.includes(cameraConfig.name)) {
          setDetectionData(data);
        }
      } catch (error) {
        console.error('Error parsing webSocket data', error);
      }
    };
    

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    

    ws.onclose = () => {
      console.log('WebSocket connection closed');
    };
    

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [cameraConfig]);


  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // If there is detection data, draw detection box and label
    if (detectionData && detectionData.payload) {

      detectionData.payload.forEach(detection => {
        if (detection.score<0.1) return;
        const [x1, y1, x2, y2] = detection.box;
        const width = x2 - x1;
        const height = y2 - y1;
        
        // Draw detection box
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, width, height);
        
        // Prepare label text (including confidence)
        const scorePercent = Math.round(detection.score * 100);
        const labelText = `${detection.label} ${scorePercent}%`;
        
        // Set font to measure text width
        ctx.font = '14px Arial';
        const textMetrics = ctx.measureText(labelText);
        const textWidth = textMetrics.width;
        const textHeight = 20; // Estimate text height
        
        // Draw label background
        ctx.fillStyle = 'rgba(255, 0, 0, 0.7)';
        ctx.fillRect(x1, y1 - textHeight, textWidth + 10, textHeight);
        
        // Draw label text
        ctx.fillStyle = 'white';
        ctx.fillText(labelText, x1 + 5, y1 - 5);
      });
      
      // Draw FPS information - upper right corner, green font
      if (detectionData.payload.length > 0){
      if ( detectionData.payload[0].fps !== undefined) {
        const fpsText = `FPS: ${detectionData.payload[0].fps.toFixed(1)}`;
        ctx.font = '16px Arial';
        const textMetrics = ctx.measureText(fpsText);
        const textWidth = textMetrics.width;
        
        // Draw background - upper right corner
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(canvas.width - textWidth - 20, 10, textWidth + 10, 30);
        
        // Draw text using green font
        ctx.fillStyle = '#00FF00'; 
        ctx.fillText(fpsText, canvas.width - textWidth - 15, 30);
      }
    }
    }
  }, [detectionData]);

  if (!cameraConfig) {
    return <ActivityIndicator />;
  }

  let player;
  if (!autoLive || !streamName) {
    player = null;
  } else if (preferredLiveMode == "webrtc") {
    player = (
      <WebRtcPlayer
        key={"webrtc_" + key}
        className={`size-full rounded-lg md:rounded-2xl ${liveReady ? "" : "hidden"}`}
        camera={streamName}
        playbackEnabled={cameraActive || liveReady}
        getStats={showStats}
        setStats={setStats}
        audioEnabled={playAudio}
        volume={volume}
        microphoneEnabled={micEnabled}
        iOSCompatFullScreen={iOSCompatFullScreen}
        onPlaying={playerIsPlaying}
        pip={pip}
        onError={onError}
      />
    );
  } else if (preferredLiveMode == "mse") {
    if ("MediaSource" in window || "ManagedMediaSource" in window) {
      player = (
        <MSEPlayer
          key={"mse_" + key}
          className={`size-full rounded-lg md:rounded-2xl ${liveReady ? "" : "hidden"}`}
          camera={streamName}
          playbackEnabled={cameraActive || liveReady}
          audioEnabled={playAudio}
          volume={volume}
          playInBackground={playInBackground}
          getStats={showStats}
          setStats={setStats}
          onPlaying={playerIsPlaying}
          pip={pip}
          setFullResolution={setFullResolution}
          onError={onError}
        />
      );
    } else {
      player = (
        <div className="w-5xl text-center text-sm">
          iOS 17.1 or greater is required for this live stream type.
        </div>
      );
    }
  } else if (preferredLiveMode == "jsmpeg") {
    if (cameraActive || !showStillWithoutActivity || liveReady) {
      player = (
        <JSMpegPlayer
          key={"jsmpeg_" + key}
          className="flex justify-center overflow-hidden rounded-lg md:rounded-2xl"
          camera={cameraConfig.name}
          width={cameraConfig.detect.width}
          height={cameraConfig.detect.height}
          playbackEnabled={
            cameraActive || !showStillWithoutActivity || liveReady
          }
          useWebGL={useWebGL}
          setStats={setStats}
          containerRef={containerRef ?? internalContainerRef}
          onPlaying={playerIsPlaying}
        />
      );
    } else {
      player = null;
    }
  } else {
    player = <ActivityIndicator />;
  }

  return (
    <div
      ref={cameraRef ?? internalContainerRef}
      data-camera={cameraConfig.name}
      className={cn(
        "relative flex w-full cursor-pointer justify-center outline",
        activeTracking &&
          ((showStillWithoutActivity && !liveReady) || liveReady)
          ? "outline-3 rounded-lg shadow-severity_alert outline-severity_alert md:rounded-2xl"
          : "outline-0 outline-background",
        "transition-all duration-500",
        className,
      )}
      onClick={onClick}
      onAuxClick={(e) => {
        if (e.button === 1) {
          window.open(`${baseUrl}#${cameraConfig.name}`, "_blank")?.focus();
        }
      }}
    >
      {((showStillWithoutActivity && !liveReady) || liveReady) && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[30%] w-full rounded-lg bg-gradient-to-b from-black/20 to-transparent md:rounded-2xl"></div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[10%] w-full rounded-lg bg-gradient-to-t from-black/20 to-transparent md:rounded-2xl"></div>
        </>
      )}
      {player}
      {!offline && !showStillWithoutActivity && !liveReady && (
        <ActivityIndicator />
      )}

      {((showStillWithoutActivity && !liveReady) || liveReady) &&
        objects.length > 0 && (
          <div className="absolute left-0 top-2 z-40">
            <Tooltip>
              <div className="flex">
                <TooltipTrigger asChild>
                  <div className="mx-3 pb-1 text-sm text-white">
                    <Chip
                      className={`z-0 flex items-start justify-between space-x-1 bg-gray-500 bg-gradient-to-br from-gray-400 to-gray-500`}
                    >
                      {[
                        ...new Set([
                          ...(objects || []).map(({ label }) => label),
                        ]),
                      ]
                        .map((label) => {
                          return getIconForLabel(label, "size-3 text-white");
                        })
                        .sort()}
                    </Chip>
                  </div>
                </TooltipTrigger>
              </div>
              <TooltipPortal>
                <TooltipContent className="capitalize">
                  {[
                    ...new Set([
                      ...(objects || []).map(({ label, sub_label }) =>
                        label.endsWith("verified") ? sub_label : label,
                      ),
                    ]),
                  ]
                    .filter((label) => label?.includes("-verified") == false)
                    .map((label) => capitalizeFirstLetter(label))
                    .sort()
                    .join(", ")
                    .replaceAll("-verified", "")}
                </TooltipContent>
              </TooltipPortal>
            </Tooltip>
          </div>
        )}

      <div
        className={cn(
          "absolute inset-0 w-full",
          showStillWithoutActivity && !liveReady ? "visible" : "invisible",
        )}
      >
        <AutoUpdatingCameraImage
          className="pointer-events-none size-full"
          cameraClasses="relative size-full flex justify-center"
          camera={cameraConfig.name}
          showFps={false}
          reloadInterval={stillReloadInterval}
          periodicCache
        />
      </div>

      {offline && !showStillWithoutActivity && (
        <div className="absolute inset-0 left-1/2 top-1/2 flex h-96 w-96 -translate-x-1/2 -translate-y-1/2">
          <div className="flex flex-col items-center justify-center rounded-lg bg-background/50 p-5">
            <p className="my-5 text-lg">Stream offline</p>
            <TbExclamationCircle className="mb-3 size-10" />
            <p className="max-w-96 text-center">
              No frames have been received on the{" "}
              {capitalizeFirstLetter(cameraConfig.name)} <code>detect</code>{" "}
              stream, check error logs
            </p>
          </div>
        </div>
      )}

      <div className="absolute right-2 top-2">
        {autoLive &&
          !offline &&
          activeMotion &&
          ((showStillWithoutActivity && !liveReady) || liveReady) && (
            <MdCircle className="mr-2 size-2 animate-pulse text-danger shadow-danger drop-shadow-md" />
          )}
        {offline && showStillWithoutActivity && (
          <Chip
            className={`z-0 flex items-start justify-between space-x-1 bg-gray-500 bg-gradient-to-br from-gray-400 to-gray-500 text-xs capitalize`}
          >
            {cameraConfig.name.replaceAll("_", " ")}
          </Chip>
        )}
      </div>

      {/* Add a canvas layer to draw the detection box */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-30 size-full pointer-events-none"
        width={cameraConfig.detect.width}
        height={cameraConfig.detect.height}
      />

      {showStats && (
        <PlayerStats stats={stats} minimal={cameraRef !== undefined} />
      )}
    </div>
  );
}
