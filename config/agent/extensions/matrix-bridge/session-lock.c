/* Small native filesystem seam shared by Node and Bun: kernel ownership and
 * atomic no-overwrite publication. No daemon, PID authority or launch claims. */
#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <string.h>
#include <sys/file.h>
#ifdef __linux__
#include <sys/syscall.h>
#include <unistd.h>
#endif

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

/* Ordinary rename may replace an unrelated empty directory. A pre-check does
 * not close that race. Fail rather than falling back on unsupported kernels. */
static napi_value rename_no_replace(napi_env env, napi_callback_info info) {
  size_t count = 2, length;
  napi_value argv[2], result;
  char paths[2][PATH_MAX];
  if (napi_get_cb_info(env, info, &count, argv, NULL, NULL) != napi_ok || count != 2) {
    napi_throw_type_error(env, NULL, "publication requires two paths");
    return NULL;
  }
  for (int i = 0; i < 2; ++i) {
    if (napi_get_value_string_utf8(env, argv[i], NULL, 0, &length) != napi_ok ||
        length == 0 || length >= PATH_MAX ||
        napi_get_value_string_utf8(env, argv[i], paths[i], PATH_MAX, &length) != napi_ok ||
        strlen(paths[i]) != length) {
      napi_throw_type_error(env, NULL, "invalid publication path");
      return NULL;
    }
  }
#ifdef __linux__
  if (syscall(SYS_renameat2, AT_FDCWD, paths[0], AT_FDCWD, paths[1], 1 /* RENAME_NOREPLACE */) != 0) {
    napi_throw_error(env, errno == EEXIST ? "EEXIST" : "EPUBLISH", "owned path publication failed without replacement");
    return NULL;
  }
  napi_get_undefined(env, &result);
  return result;
#else
  napi_throw_error(env, "ENOTSUP", "atomic task publication requires Linux renameat2");
  return NULL;
#endif
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "lock", NAPI_AUTO_LENGTH, lock_fd, NULL, &fn);
  napi_set_named_property(env, exports, "lock", fn);
  napi_create_function(env, "renameNoReplace", NAPI_AUTO_LENGTH, rename_no_replace, NULL, &fn);
  napi_set_named_property(env, exports, "renameNoReplace", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
