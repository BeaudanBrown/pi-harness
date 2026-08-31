#define _GNU_SOURCE
#include <stdio.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

int main(void) {
  uid_t uid;
#if defined(__linux__)
  struct ucred credentials;
  socklen_t length = sizeof(credentials);
  if (getsockopt(3, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0) return 1;
  uid = credentials.uid;
#elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
  gid_t gid;
  if (getpeereid(3, &uid, &gid) != 0) return 1;
#else
  return 2;
#endif
  if (printf("%lu\n", (unsigned long)uid) < 0) return 1;
  return 0;
}
