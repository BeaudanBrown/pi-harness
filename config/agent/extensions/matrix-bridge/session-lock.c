/* Small N-API seam shared by the packaged Node SDK and Bun CLI. No daemon,
 * persistent ownership claim or PID-based signalling. Descriptor ownership is
 * held by the kernel and O_CLOEXEC prevents tool descendants retaining it. */
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>

static napi_value lock_fd(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argv[1], result;
  int32_t fd;
  if (napi_get_cb_info(env, info, &count, argv, NULL, NULL) != napi_ok ||
      count != 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "lock requires a file descriptor");
    return NULL;
  }
  int flags = fcntl(fd, F_GETFD);
  if (flags == -1 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == -1) {
    napi_throw_error(env, NULL, "cannot set lock descriptor close-on-exec");
    return NULL;
  }
  int rc;
  do { rc = flock(fd, LOCK_EX | LOCK_NB); } while (rc == -1 && errno == EINTR);
  if (rc == -1 && errno != EWOULDBLOCK && errno != EAGAIN) {
    napi_throw_error(env, NULL, "kernel file locking failed");
    return NULL;
  }
  napi_get_boolean(env, rc == 0, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "lock", NAPI_AUTO_LENGTH, lock_fd, NULL, &fn);
  napi_set_named_property(env, exports, "lock", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
