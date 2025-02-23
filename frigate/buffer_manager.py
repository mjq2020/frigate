from multiprocessing import shared_memory, Value
import numpy as np
import ctypes
from dataclasses import dataclass
from typing import List, Dict, Tuple, Union


@dataclass
class DetectionResult:
    MAX_OBJECTS = 20
    RESULT_DIM = 10

    def get_buffer_size(self):
        return self.MAX_OBJECTS * 4 * self.RESULT_DIM * np.dtype("float32").itemsize


class MultiCameraBuffer:
    def __init__(
        self,
        camera_ids: List[str],
        frame_width: int,
        frame_height: int,
        frame_buffer_size: int = 3,
        batch=4,
    ):
        self.camera_ids = camera_ids
        self.num_cameras = len(camera_ids)
        self.camera_id_to_idx = {cam_id: idx for idx, cam_id in enumerate(camera_ids)}
        self.frame_shape = (batch, frame_height, frame_width, 3)
        self.frame_buffer_size = frame_buffer_size
        self.batch = batch

        self._init_frame_buffers()
        self._init_result_buffer()
        self._init_sync_variables()

    def _init_frame_buffers(self):
        shape = (self.num_cameras, self.frame_buffer_size, *self.frame_shape)
        
        size = np.prod(shape)
        self.frame_shm = shared_memory.SharedMemory(
            create=True, size=size * np.dtype("uint8").itemsize
        )
        self.frames = np.ndarray(shape, dtype=np.uint8, buffer=self.frame_shm.buf)

    def _init_result_buffer(self):
        result_size = DetectionResult().get_buffer_size() * self.num_cameras
        self.result_shm = shared_memory.SharedMemory(create=True, size=result_size)
        self.results = np.ndarray(
            (
                self.num_cameras,
                self.batch,
                DetectionResult.MAX_OBJECTS,
                DetectionResult.RESULT_DIM,
            ),
            dtype=np.float32,
            buffer=self.result_shm.buf,
        )

    def _init_sync_variables(self):
        # Use a dictionary to store synchronization variables, with the key being the camera ID
        self.write_counts = {
            cam_id: Value(ctypes.c_ulonglong, 0) for cam_id in self.camera_ids
        }
        self.read_counts = {
            cam_id: Value(ctypes.c_ulonglong, 0) for cam_id in self.camera_ids
        }
        self.result_ready = {
            cam_id: Value(ctypes.c_bool, False) for cam_id in self.camera_ids
        }
        self.frame_ready = {
            cam_id: [Value(ctypes.c_bool, False) for _ in range(self.frame_buffer_size)]
            for cam_id in self.camera_ids
        }

    def _validate_camera_id(self, camera_id: str):
        if camera_id not in self.camera_ids:
            raise ValueError(f"Invalid camera_id: {camera_id}")

    def write_frame(self, camera_id: str, frame: np.ndarray) -> bool:
        """Write a frame of image"""
        self._validate_camera_id(camera_id)
        cam_idx = self.camera_id_to_idx[camera_id]

        # Get write location
        with self.write_counts[camera_id].get_lock():
            write_pos = self.write_counts[camera_id].value % self.frame_buffer_size

        # Check if the location is writable
        ready_flag = self.frame_ready[camera_id][write_pos]
        with ready_flag.get_lock():
            if ready_flag.value:
                return False  # Buffer full

        # Writing Data
        self.frames[cam_idx, write_pos, : frame.shape[0]] = frame

        # Mark frame ready
        with ready_flag.get_lock():
            ready_flag.value = True

        # Update write count
        with self.write_counts[camera_id].get_lock():
            self.write_counts[camera_id].value += 1

        return True

    def read_frames(self) -> Dict[str, np.ndarray]:
        """Read all prepared camera frames
        Returns:
            Dict[str, np.ndarray]: The key is the camera ID, and the value is the corresponding frame data
        """
        frames = {}
        for camera_id in self.camera_ids:
            cam_idx = self.camera_id_to_idx[camera_id]

            # Get the read position
            with self.read_counts[camera_id].get_lock():
                read_pos = self.read_counts[camera_id].value % self.frame_buffer_size

            # Check for new frames
            ready_flag = self.frame_ready[camera_id][read_pos]
            with ready_flag.get_lock():
                if ready_flag.value:
                    # Reading Data
                    frames[camera_id] = self.frames[cam_idx, read_pos].copy()

                    # Mark frame read
                    ready_flag.value = False

                    # Update read count
                    with self.read_counts[camera_id].get_lock():
                        self.read_counts[camera_id].value += 1
        return frames

    def write_results(self, camera_id: str, result: np.ndarray) -> bool:
        """Write test results"""
        self._validate_camera_id(camera_id)
        cam_idx = self.camera_id_to_idx[camera_id]

        # Check if the result has been read
        with self.result_ready[camera_id].get_lock():
            if self.result_ready[camera_id].value:
                return False  # The last result has not been read yet

        # Write results
        self.results[cam_idx] = result

        # Marking results are ready
        with self.result_ready[camera_id].get_lock():
            self.result_ready[camera_id].value = True

        return True

    def read_results(self, camera_id) -> Union[np.ndarray, Dict[str, np.ndarray]]:
        """Read all prepared camera detection results"""
        results = False
        cam_idx = self.camera_id_to_idx[camera_id]
        with self.result_ready[camera_id].get_lock():
            if self.result_ready[camera_id].value:
                # Reading results
                results = self.results[cam_idx].copy()
                self.result_ready[camera_id].value = False

        return results

    def cleanup(self):
        """Cleaning up shared memory"""
        self.frame_shm.close()
        self.frame_shm.unlink()
        self.result_shm.close()
        self.result_shm.unlink()
